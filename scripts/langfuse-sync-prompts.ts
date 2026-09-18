/**
 * Push the in-repo prompt registry into Langfuse prompt management.
 *
 *   npm run langfuse:prompts          # report what would change
 *   npm run langfuse:prompts -- --push
 *
 * This is a bootstrap and drift check, not the editing workflow. The normal way
 * to change a prompt is the Langfuse UI or the playground, followed by a dataset
 * run and moving the `production` label. Use this to seed a fresh instance, or
 * to find out that the deployed prompt no longer matches what the repo thinks
 * it is.
 *
 * Creating a prompt always creates a NEW version; Langfuse never mutates one in
 * place. So the script compares first and only writes when the content or the
 * config actually differs.
 */
import { PRODUCTION_LABEL, PROMPT_REGISTRY } from "@/lib/ai/prompts";
import { getLangfuse } from "@/lib/observability/langfuse";

const push = process.argv.includes("--push");

async function main() {
  const langfuse = getLangfuse();
  if (!langfuse) {
    console.error(
      "Langfuse is not configured. Set LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY and LANGFUSE_BASEURL.",
    );
    process.exit(1);
  }

  let changed = 0;

  for (const definition of Object.values(PROMPT_REGISTRY)) {
    const existing = await langfuse
      .getPrompt(definition.name, undefined, {
        label: PRODUCTION_LABEL,
        type: "chat",
        cacheTtlSeconds: 0,
      })
      .catch(() => null);

    const same =
      existing !== null &&
      !existing.isFallback &&
      JSON.stringify(existing.prompt) === JSON.stringify(definition.messages) &&
      JSON.stringify(existing.config) === JSON.stringify(definition.config);

    if (same) {
      console.log(`= ${definition.name} v${existing.version} (unchanged)`);
      continue;
    }

    changed += 1;
    const state = existing && !existing.isFallback ? `differs from v${existing.version}` : "not on this instance";
    if (!push) {
      console.log(`~ ${definition.name} — ${state}; run with --push to create a new version`);
      continue;
    }

    const created = await langfuse.createPrompt({
      type: "chat",
      name: definition.name,
      prompt: definition.messages,
      config: definition.config,
      labels: definition.labels,
      tags: definition.tags,
      commitMessage: definition.commitMessage,
    });
    console.log(`+ ${definition.name} v${created.version} created (${state})`);
  }

  await langfuse.flushAsync();

  if (changed === 0) {
    console.log("\nLangfuse matches the repo registry.");
  } else if (!push) {
    console.log(`\n${changed} prompt(s) would change. Re-run with --push.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
