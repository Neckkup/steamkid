import { GoogleGenAI, type Content } from "@google/genai";

import { env } from "@/lib/env";
import {
  costDetails,
  costUsd,
  thinkingSettings,
  usageDetails,
  type CostBreakdown,
  type ModelId,
  type TokenUsage,
} from "@/lib/ai/models";
import { resolvePrompt, type ResolvedPrompt } from "@/lib/ai/prompts";
import {
  allowedTraceMetadata,
  getLangfuse,
  traceAiCall,
  traceUrl,
  type TraceMetadata,
} from "@/lib/observability/langfuse";
import type { TraceAudience } from "@/lib/observability/trace-destination";
import { referenceOnly } from "@/lib/privacy/redact";

/**
 * The central LLM helper. Every AI feature calls the model through here.
 *
 * The provider is the Gemini API — see
 * `docs/adr/0004-llm-provider-gemini.md`, which also records why we must stay
 * on the paid tier: free-tier Gemini traffic is used to improve Google
 * products, and children's answers are not training data for anyone but us.
 *
 * What this buys us, enforced rather than documented:
 *
 * - **A trace, always.** `traceAiCall` wraps the call, and the generation
 *   inside it carries model, prompt name + version, token counts, USD cost,
 *   latency, and the error when there is one.
 * - **A prompt version.** The prompt comes from Langfuse prompt management, so
 *   "which prompt produced this score" is answerable months later.
 * - **A cost number at call time.** Cost is computed from real token counts —
 *   thinking tokens included — and sent as `costDetails`, which is what makes
 *   cost-per-graded-item and cost-per-learner-per-month chartable.
 * - **No child identity on the wire.** The trace `userId` is a pseudonymous
 *   learner ref, trace metadata is an allow-list, and free-text defaults to a
 *   `referenceOnly()` pointer unless the caller explicitly opts in.
 *
 * Anything that reaches a model outside this function is, by team definition,
 * an unfinished feature.
 */

type LangfuseClient = NonNullable<ReturnType<typeof getLangfuse>>;
type LangfusePromptArg = Parameters<LangfuseClient["generation"]>[0]["prompt"];

let gemini: GoogleGenAI | null = null;

function getGemini(): GoogleGenAI {
  if (gemini) return gemini;
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured; cannot call the model.");
  }
  gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return gemini;
}

/**
 * The model refused to answer, or the prompt itself was blocked.
 *
 * Its own error type because a safety block on a children's product is an
 * expected event that a feature may want to handle (show the child a kind
 * message, flag the submission for a teacher) rather than a transport failure
 * to retry. What it must never become is an empty verdict that looks like a
 * grade of zero.
 */
export class ModelSafetyBlockError extends Error {
  constructor(
    readonly reason: string,
    readonly stage: "prompt" | "response",
  ) {
    super(`Gemini blocked the ${stage} (${reason}).`);
    this.name = "ModelSafetyBlockError";
  }
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
  /**
   * Client-minted `correlation_id`, used as the Langfuse trace id. Required
   * whenever `learnerRef` is set — see `resolveTraceIdentity`.
   */
  correlationId?: string;
  /** `events.session.id`, so a sitting reads as one Langfuse session. */
  sessionId?: string;
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
  /**
   * Ops escape hatch for the hardening gate — see `AiCallOptions.audience`.
   *
   * A product feature must never set this: its learner ref belongs to a child,
   * and the default classification is already the right one. It exists for
   * canaries that fabricate a learner ref on purpose, and it is ignored
   * entirely when `APP_ENV=production`.
   */
  audience?: TraceAudience;
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
      correlationId: options.correlationId,
      sessionId: options.sessionId,
      audience: options.audience,
      metadata,
      tags: options.tags,
      input: options.traceInput ?? referenceOnly("prompt-variables", prompt.definition.name),
    },
    async (ctx) => {
      const { systemInstruction, contents } = toGeminiRequest(
        prompt.client.compile(options.variables ?? {}),
      );
      const thinking = thinkingSettings(model, prompt.config.effort);

      // `ctx.langfuse`, never `getLangfuse()`: when the hardening gate refuses
      // the destination this is null, and the generation — which carries the
      // correlation id, the prompt name and the allow-listed metadata — is not
      // created either. Reaching for the client here would route around the
      // gate that just suppressed the parent trace.
      const langfuse = ctx.langfuse;
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
        metadata: allowedTraceMetadata(metadata),
        modelParameters: {
          maxTokens: prompt.config.maxTokens,
          ...(thinking ?? {}),
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

      // Filled in as soon as the response is read, so the single terminal
      // update below can carry tokens and cost even when the call ends by
      // throwing. A safety-blocked grade still burned tokens, and a cost
      // dashboard that drops them under-reports spend on exactly the prompts
      // we most need to fix.
      let billed: { usage: TokenUsage; cost: CostBreakdown | null; endTime: Date } | null = null;

      try {
        const response = await getGemini().models.generateContent({
          model,
          contents,
          config: {
            ...(systemInstruction ? { systemInstruction } : {}),
            maxOutputTokens: prompt.config.maxTokens,
            ...(thinking ? { thinkingConfig: thinking } : {}),
            // Explicit context caching (`cachedContent`) is deliberately not
            // used: it stores a child's prompt at rest on Google's side, which
            // is the one thing that breaks the zero-retention posture in ADR
            // 0004. Implicit in-memory caching is RAM-only and still priced.
            ...(options.outputSchema
              ? {
                  responseMimeType: "application/json",
                  responseJsonSchema: options.outputSchema,
                }
              : {}),
          },
        });

        const finishedAt = new Date();
        const latencyMs = finishedAt.getTime() - startedAt.getTime();

        const blockReason = response.promptFeedback?.blockReason;
        if (blockReason) throw new ModelSafetyBlockError(String(blockReason), "prompt");

        const meta = response.usageMetadata;
        const cachedInputTokens = meta?.cachedContentTokenCount ?? 0;
        const usage: TokenUsage = {
          // `promptTokenCount` includes the cached portion; billing does not
          // charge that portion at the input rate, so it is subtracted here
          // rather than double-counted.
          inputTokens: Math.max((meta?.promptTokenCount ?? 0) - cachedInputTokens, 0),
          outputTokens: meta?.candidatesTokenCount ?? 0,
          reasoningTokens: meta?.thoughtsTokenCount ?? 0,
          cachedInputTokens,
          toolUseInputTokens: meta?.toolUsePromptTokenCount ?? 0,
        };
        const cost = costUsd(model, usage, finishedAt);
        const text = response.text ?? "";
        const candidate = response.candidates?.[0];
        const stopReason = candidate?.finishReason ? String(candidate.finishReason) : null;

        billed = { usage, cost, endTime: finishedAt };

        // A response cut off by the safety filter, or by the token ceiling
        // mid-JSON, must not reach a grading caller looking like an answer.
        // Checked before the update so a blocked call leaves one terminal
        // observation marked ERROR, not a success-shaped update followed by a
        // correction that only merge semantics reconcile.
        if (stopReason === "SAFETY" || stopReason === "PROHIBITED_CONTENT") {
          throw new ModelSafetyBlockError(stopReason, "response");
        }

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
          stopReason,
        };

        return {
          output: result,
          usage: {
            input: usage.inputTokens,
            // Thinking tokens are billed as output, so the trace-level usage
            // summary counts them as output too. A grading call whose cost is
            // mostly reasoning should not look cheap here.
            output: usage.outputTokens + (usage.reasoningTokens ?? 0),
            total: meta?.totalTokenCount ?? usage.inputTokens + usage.outputTokens,
          },
        };
      } catch (error) {
        generation?.update({
          endTime: billed?.endTime ?? new Date(),
          ...(billed ? { usageDetails: usageDetails(billed.usage) } : {}),
          ...(billed?.cost ? { costDetails: costDetails(billed.cost) } : {}),
          level: "ERROR",
          statusMessage: error instanceof Error ? error.name : "unknown error",
        });
        throw error;
      }
    },
  );
}

/**
 * Gemini takes the system prompt as `systemInstruction` and the turns as
 * `contents`, while a Langfuse chat prompt stores the system prompt as a
 * leading `system` message. Only leading system messages are hoisted; one
 * appearing later is a mid-conversation operator message and stays in place as
 * a user turn, which is the closest Gemini equivalent.
 */
function toGeminiRequest(compiled: { role: string; content: string }[]): {
  systemInstruction?: string;
  contents: Content[];
} {
  const leading: string[] = [];
  let index = 0;
  while (index < compiled.length && compiled[index].role === "system") {
    leading.push(compiled[index].content);
    index += 1;
  }

  const contents: Content[] = compiled.slice(index).map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  return {
    systemInstruction: leading.length ? leading.join("\n\n") : undefined,
    contents,
  };
}

/** Structured output is schema-constrained, but never trust it blindly. */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
