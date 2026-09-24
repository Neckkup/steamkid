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
 * This script uses the one endpoint that works with the `contents:read` we do
 * have, `GET /repos/{owner}/{repo}/branches/main`, whose `protection` object is
 * the legacy shape. That shape is narrower than the settings page, and the
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
 * `strict` is not readable by any route available to us, so this script cannot
 * assert it and does not pretend to. It prints the two empirical tests that
 * close the gap instead — both of them things that happen to an agent rather
 * than things a settings page claims:
 *
 *   1. a direct `git push origin main` is rejected      (the rule binds at all)
 *   2. a PR from a branch behind `main` is blocked until
 *      it is updated                                     (strict is on)
 *
 * Step 1 of the runbook — **Allow auto-merge** — is checked here too, because
 * it is the half that fails silently. `gh pr merge --auto` does not error when
 * the repository setting is off; on PR #1 it merged immediately with no check
 * having run and reported success (ADR 0008, Q2). An agent following the
 * documented flow would believe it had armed a gated merge. That setting is not
 * on the legacy branches payload, but it is readable over GraphQL with the
 * `metadata:read` every installation holds, so it costs one extra request to
 * turn "we think auto-merge is on" into a measurement.
 *
 * Exit code is 0 only when every readable condition holds, so this is safe to
 * use as the gate on closing PRO-123, and afterwards as a drift check: a
 * required check that quietly disappears reads as FAIL here.
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

/** The merge settings from `Settings -> General -> Pull Requests`, over GraphQL. */
type MergeSettings = {
  readonly autoMergeAllowed?: boolean;
  readonly squashMergeAllowed?: boolean;
  readonly deleteBranchOnMerge?: boolean;
};

type Result = {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
};

function check(name: string, passed: boolean, detail: string): Result {
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

async function fetchBranch(token: string): Promise<BranchResponse> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/branches/${BRANCH}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    // A 403 here is not the administration gate — this endpoint needs only
    // contents:read — so say so, or the next reader will misdiagnose it.
    throw new Error(
      `GET /repos/${REPO}/branches/${BRANCH} answered ${response.status}. ` +
        `This endpoint needs only contents:read, so this is not the administration gate. ${body.slice(0, 300)}`,
    );
  }
  return (await response.json()) as BranchResponse;
}

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

function evaluate(branch: BranchResponse, merge: MergeSettings): Result[] {
  const protection = branch.protection;
  const required = protection?.required_status_checks;
  const level = required?.enforcement_level ?? "off";
  const contexts = [...(required?.contexts ?? [])].sort();
  const expected = [...REQUIRED_CHECKS].sort();

  const missing = expected.filter((name) => !contexts.includes(name));
  const extra = contexts.filter((name) => !expected.includes(name as (typeof REQUIRED_CHECKS)[number]));

  return [
    check(
      "Stage A — main is protected",
      branch.protected === true && protection?.enabled === true,
      `protected=${branch.protected}, protection.enabled=${protection?.enabled}`,
    ),
    check(
      "Stage B — required status checks are enforced",
      level !== "off",
      level === "off"
        ? "enforcement_level=off — the founder has not ticked Require status checks yet"
        : `enforcement_level=${level}`,
    ),
    check(
      "Stage B — the bypass list is empty (checks bind the owner too)",
      level === BINDS_EVERYONE,
      level === BINDS_EVERYONE
        ? `enforcement_level=${level}`
        : `enforcement_level=${level}, want ${BINDS_EVERYONE} — untick "Allow specified actors to bypass" / tick "Do not allow bypassing"`,
    ),
    check(
      "Step 1 — auto-merge is allowed on the repository",
      merge.autoMergeAllowed === true,
      merge.autoMergeAllowed === true
        ? "autoMergeAllowed=true — `gh pr merge --auto` arms a gated merge"
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

  const [branch, merge] = await Promise.all([
    fetchBranch(token.value),
    fetchMergeSettings(token.value),
  ]);
  const results = evaluate(branch, merge);

  console.log("");
  for (const result of results) {
    console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.name} — ${result.detail}`);
  }

  const failed = results.filter((result) => !result.passed);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} readable conditions hold`);

  if (merge.deleteBranchOnMerge !== true) {
    console.log("");
    console.log(
      "NOTE  deleteBranchOnMerge=false — hygiene only, not a gate. " +
        "`--delete-branch` on the PR still works.",
    );
  }

  console.log("");
  console.log("Not readable without the administration permission — prove these by doing them:");
  console.log("  strict        open a PR from a branch behind main; it must be blocked until updated");
  console.log("  rule binds    git push origin main must be rejected (PRO-123's required evidence)");

  if (failed.length > 0) {
    throw new Error(
      `Stage B is not on: ${failed.map((result) => result.name).join("; ")}. ` +
        "See docs/runbooks/enable-stage-b.md — only the founder can change this.",
    );
  }
  console.log("");
  console.log("Stage B is on as far as the readable settings go. Run the two empirical tests above.");
}

main().catch((error: Error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
