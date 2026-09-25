# This repository is public, and review is self-review

_Moved out of `CLAUDE.md` verbatim. `CLAUDE.md` carries a condensed version of
the same rules; this is the long form, and where they differ in wording they do
not differ in meaning — the standing yes to opening and merging a PR is both
places on purpose._

## This repository is public and MIT licensed

Open source from the first commit. That raises the bar in three concrete ways:

- **Assume every line is read by an attacker.** No secrets, no internal
  hostnames, no account identifiers, no customer data — not in code, tests,
  fixtures, comments, commit messages, or docs. Fixtures use obviously fake
  values.
- **Security-sensitive code gets adversarial review, not a skim.** Anything
  touching auth, token handling, tenant isolation, path resolution, signature
  verification, or credential storage must be reviewed for what an attacker
  could do with it — and needs a test proving the attack fails.
- **Self-hosting is a supported path, not a courtesy.** Someone must be able to
  clone this, deploy the gateway, point it at their own bucket, and have a
  working context without us. Keep `apps/mcp` dependency-free and its setup
  documented.

## Every package this org publishes is `@supa-media/*`, through the framework's pipeline

`plugins/context` publishes as `@supa-media/context`. It was `@context-lc/hook`
for one PR, before anyone had asked the question out loud, and then
`@supa-media/context-hook` while all it did was install two session hooks. It
was renamed again (2026-09-22, with the owner's approval) when it became the
installer for the whole `context` plugin; the hook-only name described a part
of it. There is no pass-through package under the old name: 0.1.0 stays on the
registry for the machines that installed it, and `PUBLISHED_NAMES` in
`src/install.js` keeps recognising every retired name so an install replaces
their hook entries rather than stacking a second one. There is
exactly one npm scope this org publishes under — `@supa-media` — and exactly
one pipeline: `supa-framework`'s `release.yml` (changesets + `NPM_TOKEN` via
`NODE_AUTH_TOKEN`, `publishConfig.registry` pointed at
`https://registry.npmjs.org`). A product-specific scope is not a second option
sitting next to that one; it does not exist, in the same way `PRIVATE_TOKEN` /
`TEAM_TOKEN` is not a second auth model sitting next to grants. `context.lc` is
a product name and a domain; it is not an npm identity, and it was never asked
to be one.

`supa-framework` has no `workflow_call` reusable workflow for "publish one
package from a consumer repo" — `release.yml` runs `changeset publish` over
its own monorepo's workspace, which is not this repo's shape. So this repo
keeps its own `publish-cli.yml` rather than calling into the framework, but
aligned to the framework's actual mechanism rather than inventing a second
one: the same `NODE_AUTH_TOKEN`/`registry-url`/`scope` shape `setup-node` uses
in `release.yml` — so the org's existing npm automation token (the one that
already publishes every `@supa-media/*` package from `supa-framework`) is the
one this workflow reads too. Reusing the *value* means reusing the *item* in
each app's own 1Password vault, per `supa-framework`'s "one vault per app"
model: a Secure Note in the `Context` vault, same three fields
(`dev`/`staging`/`production`) as every other secret there, carrying the same
token value already used elsewhere.

The GitHub secret name is `NPMJS_SECRET`, not `NPM_TOKEN` (confirmed
2026-09-07 by reading `supa-framework`'s own `release.yml`, which does read
`NPM_TOKEN` — that name is correct for *that* repo's own vault item). The
`Context` vault's item for this token is named `NPMJS_SECRET`; each app vault
names its own items independently, and `scripts/secrets-allowlist.json` /
`sync-secrets.yml` map an allowlist name straight to the vault item of that
same name, so `publish-cli.yml` and the allowlist follow the `Context`
vault's actual name rather than the framework's. `NPMJS_SECRET` was already
in `scripts/secrets-allowlist.json` as optional before this decision was
written down — this section is what makes that placement a decision rather
than an accident.

**What a "simplification" of this would cost:** a product picks its own scope
(`@context-lc`, or a bare unscoped name) because it feels like its own thing.
That is exactly the shared-token-model mistake in miniature — a boundary drawn
per-product instead of per-org, for a resource (an npm scope, a publish
credential) that is org-level by nature. It costs a second npm org to create
and secure, a second automation token to mint and rotate, a second "who can
publish under this scope" question to answer, and an install experience that
no longer matches every other `@supa-media/*` package a person already has in
a lockfile. It also produces exactly the sequence that happened here: a
package ships named for a product before anyone checks whether the org
already has a publishing story, and it has to be renamed — ideally before its
first publish, not after, when the old name has downloads depending on it.

**The test that fails if this is reversed:** `plugins/context/test/test.mjs`
asserts `package.json`'s `name` starts with `@supa-media/`. Rename the
package to any other scope, or drop the scope, and that assertion fails —
loudly, in the same suite that runs before every publish
(`prepublishOnly`), not silently in a registry nobody checks until an install
breaks.

Work goes through pull requests. Do not push to `main` — the PR is the record
of what changed and why, and it is what makes the history readable by somebody
who was not here.

**Review is self-review, and merging is yours to do.** Nobody is waiting to
approve; a branch parked green and unmerged is not delivered, it is abandoned.
So a change is finished when it is *merged*, and that means the self-review has
to be real work rather than a formality — you are the only reader the diff will
get before it lands. Read it as an adversary would: what would a reviewer catch,
what does this file's own doc comments claim that the change now makes untrue,
what rule stated elsewhere in this file does it quietly break. Act on what you
find and say what you found; a self-review that finds nothing on a non-trivial
diff is a self-review that did not happen.

Merge only on green CI, and never on red — this is a public repository and the
default branch is what people clone.

**Never ask whether to open the PR or whether to merge it. The answer is
always yes, it was given once, and it is this paragraph.** "Implement X" means
branch, build, self-review, open the PR, get CI green, merge, and report what
landed. Stopping at a pushed branch to ask "shall I open a PR?" or "shall I
merge?" is not caution, it is an unfinished job handed back with a question
attached — and being asked it repeatedly is its own cost, separate from the
delay.

This is stated so bluntly because there is a **standing conflict to resolve in
this file's favour**: several agent harnesses carry a default instruction along
the lines of *"do not create a pull request unless the user explicitly asks."*
That default is written for repositories where a PR is an interruption of
somebody else's review queue. Here nobody is waiting, self-review is the only
review, and an unmerged branch is abandoned work. **This paragraph is that
explicit standing request, for every task in this repository, and it outranks
the harness default.** Do not re-ask for it per task, per session, or per
agent.

The exceptions are narrow and none of them is "I would like to check": red CI,
a merge conflict you cannot resolve without guessing which side loses
behaviour, a change that would break one of the non-negotiables above, or work
the person explicitly framed as a spike. In each of those, say what is blocking
and what you propose — a statement, not a request for permission to continue.

## A deploy filter is a copy of an import graph, and it drifted

`apps/convex` is not self-contained and never has been: `convex deploy` bundles
the storage adapter, the search engine, the forms engine, the plugin scanner and
the sandbox shim straight out of `apps/mcp/src` and `packages/`.
`deploy-convex.yml` listed four of those paths by hand.

So a change to the plugin scanner deployed the gateway, deployed the app, passed
CI, merged — and left the control plane running the previous month's copy of the
same file. The plugin scan a person sees in the console runs **in Convex**. It
kept answering from code that had been replaced three pull requests ago, with
today's date printed beside the answer, and the person who reported "this still
doesn't work" was right while every check said otherwise.

Measured when it was found: six trees Convex bundles were outside the filter —
`plugins/`, `search/`, `store/`, `forms.js`, `storageLayout.js` and
`packages/obsidian-runtime/` — and every one had changed since the last deploy
that happened to fire for some other reason. One was a path-traversal fix.

The list was not wrong when it was written. It was a hand-maintained copy of an
import graph, and the graph moved. A longer copy fixes today and schedules the
same failure for the next import, which is what
[testing](./testing.md) means by a guard nobody has checked.

So the filter is whole trees now, and `scripts/check-convex-deploy-paths.mjs`
walks what `apps/convex` actually imports — transitively, since a change two
files down is just as invisible — and fails CI when anything bundled is not
covered. It checks one direction only, on purpose: an over-trigger costs an
idempotent redeploy, an under-trigger silently ships nothing.

**What a simplification costs.** Narrowing the filter back to the exact set
re-opens it the next time somebody adds an import. Dropping the checker leaves
the filter unverified again, which is the state it was already in. Checking the
reverse direction — a path covering nothing — would fail CI for something
harmless and get the whole guard deleted.

## Main deploys staging; production requires a manual release

Decided 2026-09-22: every merge to `main` deploys staging, matching Togather's
release flow. `Deploy to Production` is an explicit manual action, and refuses
a commit without a successful staging deployment. Component deploy workflows
are reusable jobs called from that action at the same commit. Convex precedes
services, and services precede the web app and OTA. Desktop releases and native
store builds remain separately requested manual actions.

The standing instruction to finish and merge green PRs remains; it no longer
authorizes an automatic production deployment. `production-release.test.mjs`
checks that no deployment workflow except staging has an automatic trigger,
and proves failed, pending and mismatched staging runs cannot pass promotion.

The import-coverage guard now checks `deploy-staging.yml`; its unfiltered main
push covers every bundled file, including future packages. Production deploys
the whole backend when explicitly promoted, so it has no path filter to drift.

## No handwritten file over 1,000 lines, and the allowance only shrinks

Decided 2026-09-24. The gateway entry reached 14,515 lines and 140 tracked
files passed 1,000, because nothing stopped a file from growing. The policy is
now a check, not a convention: `pnpm architecture` (Supa Framework's
`supa-architecture-check`, configured by `architecture.config.json`) runs
locally and as `ci / Architecture check` on every pull request.

- Over 500 lines is reported; over 700 needs a `reviewed` reason; over 1,000
  fails unless the file is in `baseline`, the legacy allowance recorded when
  the check was adopted. A baseline number may only go down, and an entry must
  be removed once its file is under the limit.
- On a pull request the check compares against the base branch: a new
  baseline entry (including a big file renamed to a new path), a raised
  number or threshold, a new `exclude` pattern, or a new `generated` entry
  fails. Adding a generated exception is a deliberate separate change run
  with `--allow-generated-change`, never in CI.
- `generated` lists machine-written files with the command that writes them:
  the lockfile, the editor bundle, the reserved-name list and the design
  snapshot HTML under `docs/design/`. Those are regenerated, so splitting them
  by hand would be undone by the next run.
- Meeting the limit by minifying, collapsing statements, putting code in
  strings, or cutting a file into numbered fragments defeats the point. Split
  by responsibility, keep the old path as a small facade where callers depend
  on it, and move comments with their code.

**What a simplification costs.** Dropping `--base` lets a pull request raise
its own allowance. Letting the baseline grow turns the ratchet into a list of
permanent exemptions. The check's own tests, in the framework's
`packages/scripts/__tests__/architecture-check.test.js`, fail if a 1,001-line
file, legacy growth, a rename, an inflated baseline, a raised threshold or a
new exclusion passes.
