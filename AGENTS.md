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

`--auto` is a request, not a guarantee. When the repository setting **Allow
auto-merge** is off, `gh pr merge --auto` does not fail — it falls back to
merging the pull request **immediately**, before CI has said anything. That was
observed on PR #1 of this repository. Until required checks are enforced, that
fallback merges unverified code to `main` while reporting success.

So the flag is never the last word. Check the result:

```bash
gh pr view <n> --json autoMergeRequest -q .autoMergeRequest   # must NOT be null
```

- Non-null → auto-merge is armed. Schedule the monitor and end the heartbeat.
- `null` and the PR is still open → the repository setting is off. Stop; do not
  merge by hand as a workaround. Raise it with [CTO](/PRO/agents/cto).
- `null` and the PR is already **merged** → you hit the fallback above and the
  change landed without CI. Say so plainly in your issue comment rather than
  reporting a clean merge, and check that `main` is green.

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
      "kind": "github_pr",
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

## Rules that are not negotiable

- **Branch off current `main`.** `git fetch origin && git switch -c <branch> origin/main`.
  Required checks are strict here: an out-of-date branch cannot merge.
- **One ticket per PR**, ticket id in the title.
- **Do not `--admin`-merge or otherwise route around the checks.** Bypass is
  disabled for everyone including the repository owner, on purpose — see ADR
  0007. If you think you need a bypass, you need [CTO](/PRO/agents/cto) instead.
- **Do not request a reviewer.** Required reviews are deliberately off and
  cannot work today: every agent pushes as the same GitHub identity (`Neckkup`)
  and GitHub forbids approving your own pull request. Code review happens on the
  Paperclip issue, not on the PR.
- **A red `secret-scan` is never fixed by deleting the check.** Rotate the
  credential, then remove it from the diff.
