import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/lib/env";
import {
  costDetails,
  costUsd,
  usageDetails,
  type CostBreakdown,
  type ModelId,
  type TokenUsage,
} from "@/lib/ai/models";
import { resolvePrompt, type ResolvedPrompt } from "@/lib/ai/prompts";
import {
  ALLOWED_TRACE_METADATA_KEYS,
  getLangfuse,
  traceAiCall,
  traceUrl,
  type TraceMetadata,
} from "@/lib/observability/langfuse";
import { pickAllowed, referenceOnly } from "@/lib/privacy/redact";

/**
 * The central LLM helper. Every AI feature calls the model through here.
 *
 * What this buys us, enforced rather than documented:
 *
 * - **A trace, always.** `traceAiCall` wraps the call, and the generation
 *   inside it carries model, prompt name + version, token counts, USD cost,
 *   latency, and the error when there is one.
 * - **A prompt version.** The prompt comes from Langfuse prompt management, so
 *   "which prompt produced this score" is answerable months later.
 * - **A cost number at call time.** Cost is computed from real token counts and
 *   sent as `costDetails`, which is what makes cost-per-graded-item and
 *   cost-per-learner-per-month chartable.
 * - **No child identity on the wire.** The trace `userId` is a pseudonymous
 *   learner ref, trace metadata is an allow-list, and free-text defaults to a
 *   `referenceOnly()` pointer unless the caller explicitly opts in.
 *
 * Anything that reaches a model outside this function is, by team definition,
 * an unfinished feature.
 */

type LangfuseClient = NonNullable<ReturnType<typeof getLangfuse>>;
type LangfusePromptArg = Parameters<LangfuseClient["generation"]>[0]["prompt"];

let anthropic: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (anthropic) return anthropic;
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured; cannot call the model.");
  }
  anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return anthropic;
}

export interface CallModelOptions {
  /** Registered prompt name, e.g. `grading/short-answer`. */
  promptName: string;
  /** Values for the prompt's `{{variables}}`. */
  variables?: Record<string, string>;
  /**
   * Trace name. Dashboards group on it, so keep it stable and hierarchical:
   * `grade.short-answer`, `path.next-lesson`.
   */
  traceName?: string;
  /** Pseudonymous learner id — never an email, a name, or an auth subject. */
  learnerRef?: string;
  metadata?: TraceMetadata;
  tags?: string[];
  /**
   * What the *trace* records as input. Defaults to a `referenceOnly()` pointer
   * built from `promptName`, because the prompt variables usually contain a
   * child's free text. Pass the real values only where the privacy policy says
   * that content may be retained in a trace.
   */
  traceInput?: unknown;
  /** Langfuse prompt label to read. Defaults to `production`. */
  promptLabel?: string;
  /** JSON schema for structured output. Strongly preferred over prose. */
  outputSchema?: Record<string, unknown>;
  /** Overrides the prompt version's model. Use only for A/B runs. */
  model?: ModelId;
}

export interface CallModelResult {
  text: string;
  /** Parsed JSON when `outputSchema` was supplied, otherwise `undefined`. */
  json?: unknown;
  traceId: string | null;
  traceUrl: string | null;
  model: ModelId;
  promptName: string;
  promptVersion: number;
  promptSource: ResolvedPrompt["source"];
  usage: TokenUsage;
  cost: CostBreakdown | null;
  latencyMs: number;
  stopReason: string | null;
}

export async function callModel(options: CallModelOptions): Promise<CallModelResult> {
  const prompt = await resolvePrompt(options.promptName, {
    label: options.promptLabel,
  });
  const model = options.model ?? prompt.config.model;
  const traceName = options.traceName ?? options.promptName;

  const metadata: TraceMetadata = {
    ...options.metadata,
    feature: prompt.definition.feature,
    promptName: prompt.definition.name,
    promptVersion: prompt.version,
    promptLabel: prompt.label,
    promptSource: prompt.source,
    model,
  };

  return traceAiCall(
    {
      name: traceName,
      learnerRef: options.learnerRef,
      metadata,
      tags: options.tags,
      input: options.traceInput ?? referenceOnly("prompt-variables", prompt.definition.name),
    },
    async (ctx) => {
      const { system, messages } = splitSystem(prompt.client.compile(options.variables ?? {}));

      const langfuse = getLangfuse();
      const startedAt = new Date();
      // The generation is created before the call so a request that never
      // returns still leaves an observation behind. A timeout that produces no
      // trace is the failure mode that makes incidents unexplainable.
      const generation = langfuse?.generation({
        traceId: ctx.traceId ?? undefined,
        name: `${traceName}.generation`,
        model,
        // The same allow-listed metadata the trace carries, repeated on the
        // generation on purpose: every cost/latency/error dashboard queries the
        // observations view, which cannot read a parent trace's metadata. Without
        // this, a widget filtered to `feature = grading` returns an empty chart.
        // `promptSource` matters most here — a fallback-served call has no linked
        // prompt, so this is the only way to find it.
        metadata: pickAllowed(
          metadata as Record<string, unknown>,
          ALLOWED_TRACE_METADATA_KEYS,
        ),
        modelParameters: {
          maxTokens: prompt.config.maxTokens,
          ...(prompt.config.effort ? { effort: prompt.config.effort } : {}),
          structuredOutput: options.outputSchema ? "json_schema" : "none",
        },
        // Linking the Langfuse prompt object is what populates the
        // prompt-version column on the generation and lets a dataset run
        // compare two versions of the same rubric. The cast bridges our
        // structural `PromptClientLike` back to the SDK's concrete class, whose
        // type lives in the transitive `langfuse-core` package; a fallback
        // prompt is deliberately not linked, because it has no version.
        prompt:
          prompt.source === "langfuse"
            ? (prompt.client as unknown as LangfusePromptArg)
            : undefined,
        input: options.traceInput ?? referenceOnly("prompt-variables", prompt.definition.name),
        startTime: startedAt,
      });

      try {
        const response = await getAnthropic().messages.create({
          model,
          max_tokens: prompt.config.maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...(options.outputSchema || prompt.config.effort
            ? {
                output_config: {
                  ...(prompt.config.effort ? { effort: prompt.config.effort } : {}),
                  ...(options.outputSchema
                    ? { format: { type: "json_schema" as const, schema: options.outputSchema } }
                    : {}),
                },
              }
            : {}),
        });

        const finishedAt = new Date();
        const latencyMs = finishedAt.getTime() - startedAt.getTime();
        const usage: TokenUsage = {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        };
        const cost = costUsd(model, usage);
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

        generation?.update({
          endTime: finishedAt,
          output: options.outputSchema ? safeParse(text) : text,
          usageDetails: usageDetails(usage),
          ...(cost ? { costDetails: costDetails(cost) } : {}),
          // An unpriced model is a gap in the cost dashboard, so it is a
          // warning on the generation rather than something to discover later.
          ...(cost ? {} : { level: "WARNING" as const, statusMessage: "no price for model" }),
        });

        const result: CallModelResult = {
          text,
          json: options.outputSchema ? safeParse(text) : undefined,
          traceId: ctx.traceId,
          traceUrl: traceUrl(ctx.traceId),
          model,
          promptName: prompt.definition.name,
          promptVersion: prompt.version,
          promptSource: prompt.source,
          usage,
          cost,
          latencyMs,
          stopReason: response.stop_reason ?? null,
        };

        return {
          output: result,
          usage: {
            input: usage.inputTokens,
            output: usage.outputTokens,
            total: usage.inputTokens + usage.outputTokens,
          },
        };
      } catch (error) {
        generation?.update({
          endTime: new Date(),
          level: "ERROR",
          statusMessage: error instanceof Error ? error.name : "unknown error",
        });
        throw error;
      }
    },
  );
}

/**
 * Anthropic takes the system prompt as its own parameter, while a Langfuse chat
 * prompt stores it as a leading `system` message. Only leading system messages
 * are hoisted; one appearing later is a mid-conversation operator message and
 * is left in place.
 */
function splitSystem(compiled: { role: string; content: string }[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const leading: string[] = [];
  let index = 0;
  while (index < compiled.length && compiled[index].role === "system") {
    leading.push(compiled[index].content);
    index += 1;
  }

  const messages = compiled.slice(index).map((message) => ({
    role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: message.content,
  }));

  return { system: leading.length ? leading.join("\n\n") : undefined, messages };
}

/** Structured output is schema-constrained, but never trust it blindly. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
