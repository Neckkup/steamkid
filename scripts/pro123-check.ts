/**
 * Prove — or disprove — that Stage B is switched on for `main`.
 *
 * `npm run verify:stage-b`
 *
 * Stage B (PRO-123) makes `verify` and `secret-scan` required status checks on
 * `main`, which is what turns "please use pull requests" into a rule. Only the
 * founder can flip it: the Paperclip GitHub App does not declare the
 * `administration` permission and therefore can never be granted it (ADR 0008,
 * Q5). So every agent is in the position of needing to *read back* a setting it
 * cannot write, and the obvious read — `GET /branches/main/protection` — is
 * itself an `administration` endpoint and answers `403`.
 *
 * ## Two places the founder could have put the rule
 *
 * GitHub has two independent branch-rule systems and the settings UI steers
 * towards the newer one. A required check configured under **Settings -> Rules
 * -> Rulesets** does not appear anywhere in the classic branch payload. So a
 * checker that reads only the classic shape reports `enforcement_level=off` and
 * announces that the founder has not ticked anything — while the rule is on and
 * blocking merges. That is a false negative on the single question this ticket
 * turns on, and it fails in the direction that wastes a person's time.
 *
 * Both are therefore read, with the `contents:read` we actually hold:
 *
 *   classic   GET /repos/{owner}/{repo}/branches/main   -> .protection
 *   ruleset   GET /repos/{owner}/{repo}/rules/branches/main
 *
 * The second is measured, not assumed: it answers `200 []` today rather than
 * `403`, which is how we know it is inside our permissions.
 *
 * ## What each source can and cannot tell us
 *
 * The classic `protection` object is narrower than the settings page, and the
 * narrowing matters, so it is spelled out rather than glossed:
 *
 *   readable   protected, protection.enabled
 *   readable   required_status_checks.enforcement_level  — "off" | "non_admins" | "everyone"
 *   readable   required_status_checks.contexts           — the check names
 *   NOT readable   strict (Require branches to be up to date)
 *   NOT readable   the bypass/allowances list, directly
 *
 * `enforcement_level` is the useful surprise. It is not a second copy of
 * "enabled" — it says *who* the required checks bind. `everyone` is the legacy
 * API's rendering of "Do not allow bypassing the above settings", i.e. the
 * repository owner is bound too. So the ticket's "bypass list is still empty"
 * criterion is readable after all, as `everyone` rather than `non_admins`.
 *
 * The ruleset source trades those two away and hands back the one the classic
 * shape withholds: a `required_status_checks` rule carries
 * `strict_required_status_checks_policy` directly, so under a ruleset **strict
 * stops being an experiment and becomes a read**. It says nothing about bypass
 * actors, because the endpoint lists the rules that apply and not who escapes
 * them.
 *
 * Nothing here pretends to know what it cannot read. A condition the configured
 * source does not expose prints `UNK`, is excluded from the score, and is listed
 * under the empirical tests that do settle it — both of them things that happen
 * to an agent rather than things a settings page claims:
 *
 *   1. a direct `git push origin main` is rejected      (the rule binds at all)
 *   2. a PR from a branch behind `main` is blocked until
 *      it is updated                                     (strict is on)
 *
 * ## Step 1, the half that fails silently
 *
 * **Allow auto-merge** is checked here too. `gh pr merge --auto` does not error
 * when the repository setting is off; on PR #1 it merged immediately with no
 * check having run and reported success (ADR 0008, Q2). An agent following the
 * documented flow would believe it had armed a gated merge. That setting is not
 * on the legacy branches payload, but it is readable over GraphQL with the
 * `metadata:read` every installation holds, so it costs one extra request to
 * turn "we think auto-merge is on" into a measurement.
 *
 * That check passing is necessary and not sufficient, which is why its PASS text
 * changes with enforcement. Auto-merge is a queue for a *blocked* pull request;
 * while no check is required, nothing is blocked, so `--auto` merges on the spot
 * whatever the setting says — measured on PR #14 with `verify` still running
 * (ADR 0008). Step 2 is what makes step 1 mean anything.
 *
 * Exit code is 0 only when every *readable* condition holds, so this is safe to
 * use as the gate on closing PRO-123, and afterwards as a drift check: a
 * required check that quietly disappears reads as FAIL here, from either source.
 */

import { execFileSync } from "node:child_process";

const REPO = process.env.STEAMKID_REPO ?? "Neckkup/steamkid";
const BRANCH = "main";

/** Exactly the two jobs in `.github/workflows/ci.yml`. A typo here is a `main` that can never merge. */
const REQUIRED_CHECKS = ["verify", "secret-scan"] as const;

/**
 * "Do not allow bypassing the above settings" as the legacy branches API spells
 * it. `non_admins` means the owner can merge past a red check, which is the
 * failure mode Stage A already closed for force pushes.
 */
const BINDS_EVERYONE = "everyone";

type LegacyProtection = {
  readonly enabled?: boolean;
  readonly required_status_checks?: {
    readonly enforcement_level?: string;
    readonly contexts?: readonly string[];
  };
};

type BranchResponse = {
  readonly protected?: boolean;
  readonly protection?: LegacyProtection;
};

/** One entry of `GET /rules/branches/{branch}`; only the rule type we care about is typed out. */
type BranchRule = {
  readonly type?: string;
  readonly ruleset_id?: number;
  readonly parameters?: {
    readonly strict_required_status_checks_policy?: boolean;
    readonly required_status_checks?: readonly { readonly context?: string }[];
  };
};

/** The merge settings from `Settings -> General -> Pull Requests`, over GraphQL. */
type MergeSettings = {
  readonly autoMergeAllowed?: boolean;
  readonly squashMergeAllowed?: boolean;
  readonly deleteBranchOnMerge?: boolean;
};

/**
 * The two sources normalised to one shape. `null` means "this source does not
 * expose it" and is carried all the way to the output rather than defaulted,
 * because defaulting it is exactly how a checker starts lying.
 */
type ChecksEvidence = {
  readonly where: string;
  readonly enforced: boolean;
  readonly bindsEveryone: boolean | null;
  readonly strict: boolean | null;
  readonly contexts: readonly string[];
};

type Result = {
  readonly name: string;
  /** `null` = not readable from the source that is configured. */
  readonly passed: boolean | null;
  readonly detail: string;
};

function check(name: string, passed: boolean | null, detail: string): Result {
  return { name, passed, detail };
}

/**
 * The token comes from the environment the caller already runs under, never
 * from the repo.
 *
 * `gh auth token` is the fallback and in practice the one that fires for
 * agents: Paperclip's `PAPERCLIP_GIT_TOKEN` is scoped to the git credential
 * helper and reads as empty in a plain shell, so an agent that only checked the
 * environment variables would conclude it has no GitHub access while `gh` is
 * sitting right there, authenticated.
 */
function resolveToken(): { value: string; source: string } {
  for (const source of ["PAPERCLIP_GIT_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[source];
    if (value) return { value, source };
  }

  try {
    const value = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    if (value) return { value, source: "gh auth token" };
  } catch {
    // `gh` missing or logged out — fall through to the same error as no env var.
  }

  throw new Error(
    "No GitHub token. Set GH_TOKEN, or run `gh auth login`; never commit one.",
  );
}

async function githubGet<T>(path: string, token: string, needs: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    // A 403 on these is not the administration gate — they need only
    // contents:read — so say so, or the next reader will misdiagnose it.
    throw new Error(
      `GET ${path} answered ${response.status}. This endpoint needs only ${needs}, ` +
        `so this is not the administration gate. ${body.slice(0, 300)}`,
    );
  }
  return (await response.json()) as T;
}

const fetchBranch = (token: string) =>
  githubGet<BranchResponse>(`/repos/${REPO}/branches/${BRANCH}`, token, "contents:read");

const fetchBranchRules = (token: string) =>
  githubGet<readonly BranchRule[]>(`/repos/${REPO}/rules/branches/${BRANCH}`, token, "contents:read");

/**
 * REST's `GET /repos/{owner}/{repo}` carries `allow_auto_merge`, but reading it
 * is gated the same way writing it is. GraphQL exposes the same three fields to
 * `metadata:read`, which every installation has, so this is the route that
 * works for an agent.
 */
async function fetchMergeSettings(token: string): Promise<MergeSettings> {
  const [owner, name] = REPO.split("/");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query:
        "query($owner:String!,$name:String!){repository(owner:$owner,name:$name)" +
        "{autoMergeAllowed squashMergeAllowed deleteBranchOnMerge}}",
      variables: { owner, name },
    }),
  });

  const body = (await response.json()) as {
    data?: { repository?: MergeSettings | null };
    errors?: readonly { message?: string }[];
  };

  if (!response.ok || body.errors?.length || !body.data?.repository) {
    const reason = body.errors?.map((error) => error.message).join("; ") ?? `HTTP ${response.status}`;
    throw new Error(`GraphQL repository query failed: ${reason}`);
  }
  return body.data.repository;
}

/**
 * Pick the source that actually carries required checks. A ruleset wins when it
 * has one, because a ruleset rule binds regardless of what the classic payload
 * says — and the classic payload says `off` for a branch ruled entirely by
 * rulesets, which is the false negative this function exists to prevent.
 */
function readChecks(branch: BranchResponse, rules: readonly BranchRule[]): ChecksEvidence {
  const rule = rules.find((entry) => entry.type === "required_status_checks");
  if (rule) {
    return {
      where: `ruleset ${rule.ruleset_id ?? "?"} (Settings -> Rules -> Rulesets)`,
      enforced: true,
      // The endpoint lists the rules that apply, not who may bypass them.
      bindsEveryone: null,
      strict: rule.parameters?.strict_required_status_checks_policy ?? false,
      contexts: (rule.parameters?.required_status_checks ?? [])
        .map((entry) => entry.context)
        .filter((context): context is string => typeof context === "string"),
    };
  }

  const required = branch.protection?.required_status_checks;
  const level = required?.enforcement_level ?? "off";
  return {
    where: "classic branch protection (Settings -> Branches)",
    enforced: level !== "off",
    bindsEveryone: level === BINDS_EVERYONE,
    // Classic protection does not expose `strict` on any endpoint we can reach.
    strict: null,
    contexts: required?.contexts ?? [],
  };
}

function evaluate(branch: BranchResponse, checks: ChecksEvidence, merge: MergeSettings): Result[] {
  const contexts = [...checks.contexts].sort();
  const expected = [...REQUIRED_CHECKS].sort();
  const missing = expected.filter((name) => !contexts.includes(name));
  const extra = contexts.filter((name) => !expected.includes(name as (typeof REQUIRED_CHECKS)[number]));

  return [
    check(
      "Stage A — main is protected",
      branch.protected === true && branch.protection?.enabled === true,
      `protected=${branch.protected}, protection.enabled=${branch.protection?.enabled}`,
    ),
    check(
      "Stage B — required status checks are enforced",
      checks.enforced,
      checks.enforced
        ? `enforced via ${checks.where}`
        : "no required checks in classic branch protection or in any ruleset — " +
          "the founder has not ticked Require status checks yet",
    ),
    check(
      "Stage B — the bypass list is empty (checks bind the owner too)",
      checks.bindsEveryone,
      checks.bindsEveryone === null
        ? `not exposed by ${checks.where} — settled by the push test below`
        : checks.bindsEveryone
          ? `enforcement_level=${BINDS_EVERYONE}`
          : `enforcement_level=${branch.protection?.required_status_checks?.enforcement_level ?? "off"}, ` +
            `want ${BINDS_EVERYONE} — untick "Allow specified actors to bypass" / tick "Do not allow bypassing"`,
    ),
    check(
      "Stage B — branches must be up to date before merging (strict)",
      checks.strict,
      checks.strict === null
        ? `not exposed by ${checks.where} — settled by the behind-main test below`
        : `strict_required_status_checks_policy=${checks.strict}`,
    ),
    check(
      "Step 1 — auto-merge is allowed on the repository",
      merge.autoMergeAllowed === true,
      merge.autoMergeAllowed === true
        ? checks.enforced
          ? "autoMergeAllowed=true — `gh pr merge --auto` arms a gated merge"
          : "autoMergeAllowed=true — but nothing on `main` blocks a pull request yet, so there is " +
            "no queue for `--auto` to join and it STILL merges immediately (measured on PR #14, " +
            "with `verify` IN_PROGRESS). This PASS means the mechanism exists, not that it gates."
        : "autoMergeAllowed=false — `gh pr merge --auto` does NOT error here, it merges " +
          "immediately with no check run. Settings -> General -> Pull Requests -> Allow auto-merge",
    ),
    check(
      "Step 1 — squash merges are allowed",
      merge.squashMergeAllowed === true,
      `squashMergeAllowed=${merge.squashMergeAllowed} — AGENTS.md prescribes \`--squash\``,
    ),
    check(
      "Stage B — exactly verify and secret-scan are required",
      missing.length === 0 && extra.length === 0,
      contexts.length === 0
        ? "no contexts configured"
        : `contexts=[${contexts.join(", ")}]` +
          (missing.length > 0 ? `; missing [${missing.join(", ")}]` : "") +
          (extra.length > 0 ? `; unexpected [${extra.join(", ")}]` : ""),
    ),
  ];
}

async function main(): Promise<void> {
  const token = resolveToken();
  console.log(`repo   ${REPO}#${BRANCH}`);
  console.log(`token  ${token.source}`);

  const [branch, rules, merge] = await Promise.all([
    fetchBranch(token.value),
    fetchBranchRules(token.value),
    fetchMergeSettings(token.value),
  ]);
  const checks = readChecks(branch, rules);
  const results = evaluate(branch, checks, merge);

  console.log(`rules  ${rules.length} ruleset rule(s) on ${BRANCH}; checks read from ${checks.where}`);

  console.log("");
  for (const result of results) {
    const label = result.passed === null ? "UNK " : result.passed ? "PASS" : "FAIL";
    console.log(`${label}  ${result.name} — ${result.detail}`);
  }

  const failed = results.filter((result) => result.passed === false);
  const unknown = results.filter((result) => result.passed === null);
  const readable = results.length - unknown.length;
  console.log("");
  console.log(`${readable - failed.length}/${readable} readable conditions hold`);

  if (merge.deleteBranchOnMerge !== true) {
    console.log("");
    console.log(
      "NOTE  deleteBranchOnMerge=false — hygiene only, not a gate. " +
        "`--delete-branch` on the PR still works.",
    );
  }

  console.log("");
  console.log("Prove these by doing them — a settings page is not evidence:");
  if (checks.strict === null) {
    console.log("  strict        open a PR from a branch behind main; it must be blocked until updated");
  }
  // Always printed. `enforcement_level=everyone` is a strong read, but PRO-123
  // asks for what happens to an agent, and only the push answers that.
  console.log("  rule binds    git push origin main must be rejected (PRO-123's required evidence)");

  if (failed.length > 0) {
    throw new Error(
      `Stage B is not on: ${failed.map((result) => result.name).join("; ")}. ` +
        "See docs/runbooks/enable-stage-b.md — only the founder can change this.",
    );
  }
  console.log("");
  console.log("Stage B is on as far as the readable settings go. Run the tests above.");
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
