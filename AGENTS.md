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
# gh pr merge --squash --auto --delete-branch  <- NOT YET. See the section below.
```

Then schedule the monitor below and **end the heartbeat.** Do not poll, do not
sleep, do not re-run `gh pr checks` in a loop.

**The fifth command is suspended until Stage B step 2 lands.** `--auto` is
supposed to hand the waiting to GitHub. On this repository today it does not: it
merges immediately, before CI has finished. Measured twice, most recently on
PR #14 on 2026-09-24 with `autoMergeAllowed=true` — armed while `verify` was
still `IN_PROGRESS`, and the pull request was on `main` seconds later with
`autoMergeRequest: null`. Turning the repository setting on was necessary and did
not fix this. **What gates a merge is required status checks, and those are still
`off`** (`npm run verify:stage-b`). Until that verifier reports Stage B on, open
the PR, schedule the monitor, and merge by hand on green.

## `--auto` merges now, not on green — why the fifth command is suspended

**Allow auto-merge is on** as of 2026-09-24; the founder ticked it and
`npm run verify:stage-b` reads `autoMergeAllowed=true`. That fixed the setting
and did **not** fix the behaviour.

`--auto` is a request, not a guarantee. GitHub only has something to wait for
when a pull request is *blocked* — and with no required status checks configured,
nothing blocks it, so `--auto` merges on the spot and reports success:

| PR | `autoMergeAllowed` | Checks when armed | Result |
| --- | --- | --- | --- |
| #1 | `false` | pending | merged immediately, `autoMergeRequest: null` |
| #12 | `true` | both green | merged immediately, `autoMergeRequest: null` |
| #14 | `true` | `verify` **in progress** | merged immediately, `autoMergeRequest: null` |

PR #14 is the one that settles it: the setting was on, CI had not finished, and
the change was on `main` anyway. Required status checks — Stage B step 2, still
`enforcement_level=off` — are the thing that makes a merge wait. The repository
setting only makes a *gated* merge expressible once something does the gating.

So the flag is never the last word. Check the result:

```bash
gh pr view <n> --json autoMergeRequest -q .autoMergeRequest   # must NOT be null
```

- Non-null → auto-merge is armed. Schedule the monitor and end the heartbeat.
- `null` and the PR is still open → auto-merge did not arm and nothing will
  merge it. Schedule the monitor and merge by hand on green.
- `null` and the PR is already **merged** → you hit the fail-open path in the
  table above. Say so plainly in your issue comment rather than reporting a clean
  armed merge, check whether both checks were green at merge time, and check that
  `main` is green now. This is the outcome you avoid by not running `--auto`.

## Before you end that heartbeat, schedule one monitor

Nothing merges your PR while you are asleep — not until Stage B lands and
`--auto` becomes usable. The monitor is what brings you back to merge it. The
same heartbeat that opens the PR schedules a single issue monitor, and that
monitor is the only thing that ever re-checks:

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
`in_progress` or `in_review`, and exit. On the wake: if both checks are green,
run `gh pr merge <n> --squash --delete-branch` (no `--auto`), clear the monitor
and finish the ticket. If CI is red, fix it and push to the same branch, then
re-arm the monitor.

**`blocked` and a monitor are mutually exclusive.** The scheduler only wakes
issues in `in_progress` or `in_review`, so `PATCH`ing `status: "blocked"` in the
same request that sets the monitor stores the timestamp against an issue that
can never fire — and the response comes back with `monitorNextCheckAt: null`
rather than an error. Observed on PRO-123. If a pull request is still in flight,
the issue is not blocked; leave it `in_review`. Only mark it `blocked` once
nothing is left to wake for, and say who unblocks it.

**A monitor watches CI. It does not watch a human.** The monitor above exists
because a CI run finishes on its own schedule and nothing tells you when. A
founder clicking a checkbox is the opposite: it has no schedule, and Paperclip
*does* tell you when. If what you are waiting for is a person, the wake path is
an issue interaction with `continuationPolicy: "wake_assignee"` — a
`request_confirmation` card wakes you on the click and on the decline, exactly
once each. Measured on PRO-123: the Stage B monitor fired eight times across
eight heartbeats and read the same `enforcement_level=off` every time, because a
15-minute timer cannot make a person faster. Re-stating the ask in a ninth
comment does not either. Post the card, leave the issue `in_review`, and let the
card be the only thing that brings you back.

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
