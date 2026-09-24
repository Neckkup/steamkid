<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Diagrams are Mermaid

Any diagram you produce — in `docs/`, an ADR, a runbook, a plan, a PR
description, or a task comment — is a `mermaid` code block in Markdown. Not a
screenshot, not ASCII art, not an exported image. Read `docs/diagrams.md` for
the diagram-type table and house rules before drawing one.

# How changes reach `main`

`main` is protected. Read [ADR 0008](docs/adr/0008-pr-flow-on-main.md) once; this
section is the operating summary.

**Never `git push origin main`.** Every change arrives through a pull request
that passes two required checks, `verify` and `secret-scan`.

**Never spend a heartbeat waiting for CI.** That is the whole point of the flow
below: you open the PR, hand the waiting to GitHub, and end the run.

## The five commands

```bash
git switch -c pro-123-short-slug          # branch name: <ticket>-<slug>
git commit -m "Imperative summary (PRO-123)"
git push -u origin HEAD
gh pr create --fill                        # title ends with the ticket id
gh pr merge --squash --auto --delete-branch # GitHub merges when both checks pass
```

Then **end the heartbeat.** Do not poll, do not sleep, do not re-run `gh pr
checks` in a loop. `--auto` means GitHub merges the PR itself the moment
`verify` and `secret-scan` go green. Nothing needs to be awake for that.

## Confirm auto-merge actually armed — `--auto` can silently merge instead

**Today, on this repository, `--auto` still merges instantly without waiting for
CI.** `Allow auto-merge` is on as of 2026-09-24 — `npm run verify:stage-b` reads
`autoMergeAllowed=true` — and it did **not** fix this. Measured on PR #13: with
the setting on, `gh pr merge --squash --auto` merged the pull request on the
spot, `autoMergeRequest` read back `null`, and `main`'s CI for that commit was
still `pending` afterwards.

The cause is not the repository setting. **GitHub only creates an auto-merge
request for a pull request that is currently blocked from merging.** With no
required status checks on `main`, a freshly opened PR is already mergeable —
pending checks do not block when nothing requires them — so there is nothing to
queue and `--auto` degrades to a plain merge. Step 1 was necessary and is done;
**the fail-open behaviour closes with step 2, the required checks, not before**
(PRO-123, [ADR 0008](docs/adr/0008-pr-flow-on-main.md) Q2).

So until `npm run verify:stage-b` passes, **do not use `--auto` for anything you
would not want on `main` unverified.** Open the PR, leave it, schedule the
monitor below, and merge on the wake once both checks are green.

Either way the flag is never the last word. Check the result:

```bash
gh pr view <n> --json state,autoMergeRequest -q '[.state,.autoMergeRequest]'
```

- Non-null and `OPEN` → auto-merge is armed. Schedule the monitor and end the
  heartbeat.
- `null` and still `OPEN` → nothing is armed and nothing merged. Schedule the
  monitor and merge on the wake; do not loop on `gh pr checks`. **Do not read
  this as the repository setting being off** — that diagnosis was in this list
  and was wrong (PRO-129).
- `null` and already `MERGED` → GitHub had nothing left to wait for and merged on
  the spot. Benign *only if* both checks were already green when you armed it,
  which is what PR #12 saw; if they were not, the change landed without CI, which
  is what PR #13 saw. Say which of the two it was in your issue comment rather
  than reporting a clean armed merge, and check that `main` is green.

## Before you end that heartbeat, schedule one monitor

Auto-merge fires on green. It does **not** fire when CI is red or the branch
conflicts — the PR just sits there forever and your work never lands. So the
same heartbeat that enables auto-merge schedules a single issue monitor, and
that monitor is the only thing that ever re-checks:

```jsonc
PATCH /api/issues/{issueId}
{
  "executionPolicy": {
    "monitor": {
      // "external_service" is the only accepted kind. "github_pr" is rejected
      // with a 400 — the PR being watched goes in externalRef, not in kind.
      "kind": "external_service",
      "serviceName": "github-actions",
      "externalRef": "https://github.com/Neckkup/steamkid/pull/<n>",
      "nextCheckAt": "<now + 15 minutes, ISO 8601>",
      "timeoutAt": "<now + 2 hours, ISO 8601>",
      "maxAttempts": 4
    }
  }
}
```

Confirm the response echoes a non-null `monitorNextCheckAt`, keep the issue
`in_progress` or `in_review`, and exit. On the wake: if the PR merged, clear the
monitor and finish the ticket. If CI is red, fix it and push to the same branch —
auto-merge stays armed across pushes.

**`blocked` and a monitor are mutually exclusive.** The scheduler only wakes
issues in `in_progress` or `in_review`, so `PATCH`ing `status: "blocked"` in the
same request that sets the monitor stores the timestamp against an issue that
can never fire — and the response comes back with `monitorNextCheckAt: null`
rather than an error. Observed on PRO-123. If a pull request is still in flight,
the issue is not blocked; leave it `in_review`. Only mark it `blocked` once
nothing is left to wake for, and say who unblocks it.

## Rules that are not negotiable

- **Branch off current `main`.** `git fetch origin && git switch -c <branch> origin/main`.
  Required checks are strict here: an out-of-date branch cannot merge.
- **One ticket per PR**, ticket id in the title.
- **Do not `--admin`-merge or otherwise route around the checks.** Bypass is
  disabled for everyone including the repository owner, on purpose — see ADR
  0007. If you think you need a bypass, you need [CTO](/PRO/agents/cto) instead.
- **Repository settings are not yours to change — and not because of policy.**
  The Paperclip GitHub App does not declare the `administration` permission, so
  it can never be granted one. Branch protection, rulesets, auto-merge and
  repository settings all answer `403` for every agent, permanently. **The
  Actions `GITHUB_TOKEN` is no way around this** — `administration` is not an
  accepted key in a workflow's `permissions:` block at all, so a workflow that
  asks for it is rejected before any job starts. Both credentials an agent can
  reach have been measured; neither can ever hold it. If a task
  needs one of those, it needs the founder at the GitHub UI; do not spend a
  heartbeat re-testing the permission or asking for it to be granted. See ADR
  0008, Q5 — this has been measured on four separate tickets. To check the state
  of `main`'s protection without that permission, run `npm run verify:stage-b`;
  to hand the founder the settings change, link
  [docs/runbooks/enable-stage-b.md](docs/runbooks/enable-stage-b.md) rather than
  retyping the clicks into a comment.
- **Do not request a reviewer.** Required reviews are deliberately off and
  cannot work today: every agent pushes as the same GitHub identity (`Neckkup`)
  and GitHub forbids approving your own pull request. Code review happens on the
  Paperclip issue, not on the PR.
- **A red `secret-scan` is never fixed by deleting the check.** Rotate the
  credential, then remove it from the diff.
