/**
 * Preflight for a freshly provisioned Langfuse instance.
 *
 *   npm run langfuse:verify
 *
 * Run this BEFORE `langfuse:prompts --push`, `langfuse:dashboards --push`, or
 * `ai:smoke`. It answers the one question that is expensive to get wrong and
 * impossible to see from the ingest side: is this instance a major version that
 * can actually run the alerts and dashboards we already specified?
 *
 * Exits non-zero on anything other than a confirmed v4+. A v3 instance is the
 * dangerous case — it is healthy, it accepts traces, and it silently cannot be
 * alerted on. Failing here is much cheaper than finding out in week six.
 */
import { env } from "@/lib/env";
import { checkLangfuseHardening } from "@/lib/observability/langfuse-hardening";
import {
  MINIMUM_LANGFUSE_MAJOR,
  PINNED_LANGFUSE_TAG,
  checkLangfuseServerVersion,
} from "@/lib/observability/langfuse-version";

async function main() {
  const baseUrl = env.LANGFUSE_BASEURL;
  console.log(`checking Langfuse at ${baseUrl ?? "(LANGFUSE_BASEURL unset)"}`);

  const result = await checkLangfuseServerVersion({ baseUrl });

  if (!result.ok) {
    console.error(`FAIL [${result.status}] ${result.reason}`);
    if (result.status === "too_old") {
      console.error(
        `     Do not push prompts or dashboards at this instance. Redeploy on ` +
          `${PINNED_LANGFUSE_TAG} (>= v${MINIMUM_LANGFUSE_MAJOR}) — see ` +
          `docs/runbooks/langfuse-self-host.md.`,
      );
    }
    process.exit(1);
  }

  console.log(`OK  ${result.reason}`);
  console.log(`    pinned tag for provisioning: ${PINNED_LANGFUSE_TAG}`);

  // Capability is only half the question. The other half is whether this
  // instance is safe to put a child's free-text answer into.
  const hardening = await checkLangfuseHardening({ baseUrl });

  for (const finding of hardening.findings) {
    if (finding.ok) {
      console.log(`OK  [${finding.id}] ${finding.reason}`);
      continue;
    }
    console.error(`FAIL [${finding.id}] ${finding.reason}`);
    console.error(`     fix: ${finding.remedy}`);
  }

  if (!hardening.reachable) {
    console.error(
      "FAIL none of the hardening checks could reach a conclusion. Treat this " +
        "instance as unverified rather than clean — see " +
        "docs/runbooks/langfuse-self-host.md.",
    );
    process.exit(1);
  }

  if (!hardening.ok) {
    console.error(
      "\nThis instance is capable but not hardened. Do not point a preview or " +
        "production tier at it, and do not let a real learner trace land in it " +
        "until the failures above are cleared.",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
