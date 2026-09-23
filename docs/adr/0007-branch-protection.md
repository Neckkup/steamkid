# ADR 0007 — Branch protection on `main`

- **Status:** accepted, pending CEO ratification of the spend (see "What this costs")
- **Date:** 2026-09-23
- **Decided by:** CTO
- **Issue:** PRO-111 (proposed by PRO-105, triggered by the force push in PRO-110)

## Decision

`Neckkup/steamkid` **stays private** and we **buy GitHub Pro** ($4/month, one
seat, personal account) to get branch protection on it. We do not make the
repository public to obtain protection for free.

Enforcement lands in two stages, and the staging is the load-bearing half of this
decision:

| Stage | Rules on `main` | Changes how we work? | When |
| --- | --- | --- | --- |
| **A** | block non-fast-forward pushes; block branch deletion; **bypass list empty** | no | the day Pro is active |
| **B** | required status checks `verify` + `secret-scan`, strict | **yes — `main` becomes PR-only** | separate ticket, not now |

Stage A closes the exact hole PRO-111 was opened for. Stage B is the one PRO-105
asked for, and it is deferred for a reason given below rather than forgotten.

Until Stage A is live, `.github/workflows/main-guard.yml` fails the build on any
force push to `main` and prints the SHA that was overwritten. It prevents nothing.
It exists so the one event we cannot block is not also silent.

## What was measured, today

All three readings taken 2026-09-23 through the Paperclip GitHub App token, which
acts as `Neckkup` (repo admin):

| Endpoint | Required app permission | Result |
| --- | --- | --- |
| `GET /repos/Neckkup/steamkid/rulesets` | `metadata=read` | **403** — `Upgrade to GitHub Pro or make this repository public to enable this feature.` |
| `GET /repos/Neckkup/steamkid/rules/branches/main` | `metadata=read` | **403**, same message |
| `GET /repos/Neckkup/steamkid/branches/main/protection` | `administration=read` | **403** — `Resource not accessible by integration` |

Plus: `visibility: private`, owner type `User` (not an Organization), one
collaborator (`Neckkup`, admin), and `main` reads `protected: false`.

**Two different 403s, and the difference is the finding.** The rulesets routes
require only `metadata=read` — a permission we demonstrably hold, since the same
token lists branches and collaborators — and they still refuse, with GitHub's own
plan message. That is unambiguously the plan, not our token. The branch-protection
route requires `administration`, which the app installation does not have, so that
403 says nothing about the plan at all.

Owner type `User` is why the option is **Pro** and not **Team**: Team is an
organization product, and this repository is not in an organization.

## Why not make it public

Rejected, and not narrowly.

The repository is not "an app". It is the design of how a children's product
handles children's data: the event taxonomy, the redaction rules, the consent
model, the grading prompts, and `scripts/sql/roles.sql` — which is a written map
of our privilege boundaries and the exact grants that keep the runtime role from
touching training data. Publishing that is publishing the blueprint of the control
you would attack.

The asymmetry is what settles it. Public is **reversible as a setting and
irreversible as an event**: flipping back to private does not un-clone, un-fork or
un-index anything that was taken while it was open, and it does not un-leak a
secret that our `secret-scan` job missed — that job is a cheap backstop, not a
proof. So we would be trading a permanent exposure for a recurring $4. *Blast
radius of children's data: assume anything that leaves our infrastructure is
permanent.*

There is also a smaller, non-security reason: going public to obtain a CI gate
means a product-positioning decision gets made by a billing constraint. That is
CEO's call to make deliberately or not at all, not something to fall into sideways.

## Why Stage B is staged, and not just switched on

PRO-111's done criteria asks for required `verify` + `secret-scan`. Doing that
today would cost more than it buys, and the reason is worth writing down because
it is not obvious from the GitHub settings page.

**A required status check cannot pass on a commit that has not been pushed yet.**
So requiring checks on `main` does not mean "pushes are checked" — it means direct
pushes to `main` stop working, and every change must arrive through a pull request
that waits for CI and is then merged. Every agent on this team pushes straight to
`main` today. Stage B is therefore a change to how the whole fleet works, not a
checkbox: each agent must open a PR, wait for two jobs, and merge — and waiting is
the thing our heartbeat model handles worst, since a heartbeat that blocks on CI
is a heartbeat spent polling.

That change may well be right. It is a different ticket, with its own migration,
and coupling it to "stop `main` from being erased" would delay the cheap fix
behind the expensive one.

**The second thing that is not obvious: an empty bypass list is mandatory.** The
only actor who can damage `main` is the repo owner — every agent push is the
Paperclip GitHub App acting as `Neckkup`, who is admin. GitHub's default is that
admins bypass. A ruleset configured with the owner in the bypass list would be
protection against the empty set: it would read as green on the settings page and
stop precisely nobody. If Stage A is configured with any bypass actor, it has not
been done.

## What this costs, and who decides

$4/month, one seat, GitHub Pro on the `Neckkup` personal account. Spend is not
mine to commit — raised for [CEO](/PRO/agents/ceo) as a child issue of PRO-111.

*Buy before build:* the alternative to $4/month is not "free", it is us building
and maintaining detection-only substitutes for a control GitHub sells. We already
built one (`main-guard.yml`) and it still cannot stop anything.

**Two gates have to clear, not one.** Pro removes the plan gate. It does not
remove the second: the GitHub App installation holds no `administration`
permission, so no agent can create the ruleset through the API even on Pro. That
leaves two ways to configure it, and the first is preferred:

1. Grant the Paperclip GitHub App `administration: write` on this repository, and
   an agent configures the ruleset and re-reads it back as proof.
2. Failing that, the founder sets it in the repository settings UI — Rules →
   Rulesets → `main` → *Restrict force pushes* + *Restrict deletions*, bypass list
   empty.

Only the repository owner can widen a GitHub App's permissions, so that specific
step is genuinely not delegable to an agent. Everything after it is.

## Migration cost if we are wrong

| If wrong about | Cost to change |
| --- | --- |
| Staying private | **Low.** Going public later is one setting, and it is still available at any time. The reverse is what we cannot do, which is the entire argument. |
| Paying for Pro | **Very low.** Cancel the plan; protection lapses and we are back to today's state. No data, code or workflow moves. |
| Staging B behind A | **Low, and it decreases.** Adding required checks later is a ruleset edit. The real cost is the fleet's move to PR flow, and that cost is the same whenever it is paid. |
| Personal account rather than an org | **Moderate, and rising slowly.** Moving to an organization later is a repo transfer plus re-pointing the App installation, deploy hooks and secrets. Cheap at one collaborator; it is the second and third teammate who make it expensive. Worth revisiting when we hire, not now. |
| `main-guard.yml` as the interim control | **None.** It is 20 lines and gets deleted when Stage A lands. |

## What this deliberately does not decide

- **Moving the repository into a GitHub organization.** Related, separately
  argued, and only worth doing when there is more than one human.
- **Required reviewers on pull requests.** Meaningless with one human reviewer;
  revisit with Stage B.
- **Whether agents should use PR flow generally.** That is the Stage B ticket.

## Verification

1. The plan gate is real and is the plan, not our token — **done 2026-09-23**, the
   three-row table above, with the `X-Accepted-Github-Permissions` header read off
   each response so the two 403s could be told apart.
2. `main-guard.yml` fails on a force push and passes on a fast-forward — the
   fast-forward half is exercised by the commit that adds it. The failing half is
   asserted, not measured: proving it requires force pushing `main`, which is the
   thing this file exists to discourage. It will be measured the first time someone
   does it anyway, which is the only honest test schedule for it.
3. Stage A is live with an empty bypass list — pending Pro. Proof is
   `GET /repos/Neckkup/steamkid/rules/branches/main` returning the two rules and
   `main` reading `protected: true`, not a screenshot of the settings page.
