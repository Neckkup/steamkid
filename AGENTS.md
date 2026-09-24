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
git fetch origin && git switch -c pro-123-short-slug origin/main
git commit -m "Imperative summary (PRO-123)"
git push -u origin HEAD
gh pr create --fill                          # title ends with the ticket id
gh pr merge --squash --auto --delete-branch  # then read the result back, below
```

Then **end the heartbeat.** Do not poll, do not sleep, do not re-run
`gh pr checks` in a loop.

## `--auto` gates now — Stage B landed 2026-09-24

The fifth command was suspended for most of this repository's life, because
`--auto` merged on the spot instead of on green. It was never the flag's fault.
GitHub only has something to wait for when a pull request is **blocked**, and
until `main` had required status checks, nothing blocked anything: `--auto`
found an already-mergeable PR, merged it, and reported success.

| PR | `autoMergeAllowed` | Required checks on `main` | Checks when armed | Result |
| --- | --- | --- | --- | --- |
| #1 | `false` | none | pending | merged immediately, `autoMergeRequest: null` |
| #12 | `true` | none | both green | merged immediately, `autoMergeRequest: null` |
| #14 | `true` | none | `verify` **in progress** | merged immediately, `autoMergeRequest: null` |
| #24 | `true` | `verify` + `secret-scan` | `verify` in progress | **queued** — `autoMergeRequest` non-null |

Required status checks are now on (`enforcement_level=everyone`, contexts
`verify` and `secret-scan`, bypass bound to everyone including the owner). That
is what makes a merge wait, so the fifth command does what it always claimed to.

**Still read the result back.** A flag is a request, not a receipt:

```bash
gh pr view <n> --json autoMergeRequest -q .autoMergeRequest   # must NOT be null
```

- Non-null → auto-merge is armed. End the heartbeat; GitHub does the waiting.
- `null` and the PR is still open → it did not arm. Schedule the monitor below
  and merge by hand on green.
- `null` and the PR is already **merged** → you hit the old fail-open path. Say
  so plainly in your issue comment rather than reporting a clean armed merge,
  check whether both checks were green at merge time, and check `main` is green.

## When a PR stalls, schedule one monitor

Auto-merge does the waiting on the happy path. It does **not** fire when CI goes
red — the PR then sits open forever with nobody watching. The monitor is the
backstop for that case, and for any PR you had to merge by hand:

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
