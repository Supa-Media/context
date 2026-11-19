# Per-branch preview environments

Decided by the owner (Seyi), 2026-11-19: every pushed branch with an open pull
request gets its own live copy of Context and Tex, built from that branch's
code, so a change can be tried against a real backend before it merges. The
copy is isolated from production and staging, holds only seeded fictional
people, and sends no text and no email.

## What a preview is

A preview is named `pr<N>`, where `N` is the pull request number (the pattern
is `^pr[1-9][0-9]{0,6}$`). For each one, `.github/workflows/preview.yml`
deploys:

- a **Convex preview deployment**, made with `npx convex deploy --preview-name
  pr<N>` and a preview deploy key (the GitHub secret
  `CONVEX_PREVIEW_DEPLOY_KEY`, in the GitHub environment `preview`);
- the **gateway** `context-mcp-pr<N>` and the **texting assistant**
  `context-agent-pr<N>`, both Workers on `workers.dev`, on every run;
- the **router** `context-router-pr<N>` with the **web app** export, only when
  `apps/mobile` or `infra/router` changed.

`scripts/deploy-plan.mjs --target preview` chooses the Workers from the files
that changed. A preview's first deployment has no Worker to compare with, so it
deploys every component. Convex is deployed on every run, because the seed has
to run on every push and the preview's URL comes from that deploy.

## Why named scripts and not preview aliases

Cloudflare does not generate a version URL for a Worker that has Durable
Objects, so a per-version alias cannot stand in for a preview. Each preview is
instead a separately named Worker, deployed under `context-*-pr<N>` with
`wrangler deploy --config <rendered file> --env preview --name <name>`. The
rendered configs are copies made by `scripts/preview-config.mjs` from the
`env.preview` section at the end of each Worker's config, with the placeholders
`__PREVIEW__` and `__WORKERS_DEV__` filled in. The originals are not edited.

The account's workers.dev subdomain names the account, and this repository is
public. The subdomain is read from the API at run time and masked, and no
committed file or public log contains it.

## Full isolation

A preview is a separate world, not a view onto staging or production.

- **Its own Convex deployment and its own Durable Object namespaces, both
  empty when created.** Nothing is copied from production or staging, and the
  preview never reads or writes their data, not even read-only.
- **Bindings to staging only where a binding has no data of its own.** The
  site-screenshot, Tex-evaluation and transcription Workers are bound to their
  staging Workers, because they hold no customer state. Everything else is the
  preview's own.
- **No Photon binding, and no Vectorize, D1 or R2 binding in the preview's
  config.** The Convex side creates those resources itself at run time, and it
  prefixes every one of them with `pr<N>-` (`previewResourcePrefix()` in
  `apps/convex/functions/lib/previewDeployment.ts`): the managed bucket
  `pr<N>-ctx-<workspaceId>`, the search database `pr<N>-context-search-<id>`,
  and the meaning index `pr<N>-context-meaning-<id>`. Cleanup finds them by
  that prefix, and no preview name can equal a production or staging name for
  the same workspace.
- **Analytics Engine datasets end in `_preview`.** Each is the staging name
  with `_preview` in place of `_staging`, such as `tex_text_timing_preview`.
- **Workflows end in `-pr<N>`**, such as `group-turn-pr<N>` and
  `job-run-pr<N>`.

## Silence

A preview must never be able to send a text, an SMS, an email or a payment.

- **No texting, SMS, mail or billing key is set on a preview.** The list lives
  in `scripts/preview-guards.mjs` as `FORBIDDEN_PREVIEW_KEYS`: the texting-line
  keys (Linq, Sendblue, Whapi, Photon and `TEX_LINE_NUMBERS`), the SMS keys
  (Twilio), the mail key (`RESEND_API_KEY`) and the Stripe webhook secret.
  `preview-guards.mjs silence` runs in CI before the first deploy and fails
  the deploy if any of them is non-empty, naming the variable and never its
  value. `scripts/preview-convex-env.mjs` also removes any of them that a
  project default has put on the deployment.
- **The texting assistant's health is checked.** `preview-guards.mjs
  agent-health` reads `<agent>/health` and fails if any live-line flag is true
  (the Linq, Sendblue, Whapi and Photon flags, and the `webhook` and `replies`
  flags). It then requires `/texts-simulator` to answer 200.
- **Texting happens only through `/texts-simulator`**, from made-up numbers in
  the range +1 212 555 01XX (`0100` to `0199`). `scripts/preview-smoke.mjs`
  refuses any other number.

## Identity: when a preview is a preview

Everything a preview may do that production may not is gated by one function,
`isIsolatedPreview(env)` in `apps/convex/functions/lib/previewDeployment.ts`.
It holds only when all four legs hold, each ruling out a different mistake:

1. `APP_ENV` is exactly `preview`;
2. `PREVIEW_NAME` is `pr<N>`, the name the workflow gave;
3. `APP_ORIGIN` is that preview's own router on `workers.dev`, never a
   `context.lc` or `tex.lc` host;
4. `CONVEX_CLOUD_URL` is a `.convex.cloud` deployment that is not the one
   `STAGING_CONVEX_DEPLOYMENT` names.

An operator who copies production's variables onto a preview, or a preview's
onto production, fails leg 3, because production's `APP_ORIGIN` is
`https://context.lc`.

The check widens in these places, and no others:

| Where | What it allows on a preview | Production still refuses (test) |
| --- | --- | --- |
| `lib/issuedSignInCodes.ts` (`signInCodes:issue`) | a sign-in code issued to a persona | `issuedSignInCodes.test.ts`: "are refused on production even with the preview variables copied onto it" |
| `functions/seed.ts` (`seed:preview`) | the seed of personas, workspaces, folders and phones | `seedPreview.test.ts`: "refuses on production and writes nothing" |
| `functions/stagingPersonas.ts` | the persona seed | `stagingPersonas.test.ts`: "refuses on production, and with preview variables copied onto production, without writing" |
| `lib/nameClaims.ts` | the reserved `@alpha` name, for the persona seed only | `stagingPersonas.test.ts` (the preview seed claims it; production has no such path) |
| `lib/phoneCheck.ts` | the phone check is skipped for `alpha@supa.media` | `phoneCheck.test.ts`: "production does not, not even with the preview variables copied onto it" |
| `lib/managedStorage.ts` (`previewStorageIsFree`) and `lib/billing/*` | free managed storage and the test premium upgrade, for an ordinary owner | `previewStorageNames.test.ts`: "is off for production, and for production with the preview variables copied onto it"; `billing/previewBilling.test.ts`: "the preview variables copied onto production still refuse an ordinary owner" |
| the resource prefixes (`d1.ts`, `vectorize.ts`, `managedStorage.ts`) | `pr<N>-` in front of every name created | `previewStorageNames.test.ts`: "a production deployment with the preview variables copied onto it keeps production's names" |

The one check that narrows rather than widens is `texExamplesIndex.ts`, which
refuses to write the shared Tex examples index on a preview. Its test is
"an isolated preview refuses to write the shared index, before any request".

No other code reads `APP_ENV`, `PREVIEW_NAME` or `APP_ORIGIN` to decide a
widening. Each caller asks `isIsolatedPreview()` or the function built on it.

## Production identifiers are refused before the deploy

`preview-guards.mjs identity` runs before and after the Convex deploy. It
requires the Convex deploy key to start with `preview:`, and the preview URL
to be `https://<name>.convex.cloud`. Neither may contain an entry from
`PREVIEW_DENY_IDENTIFIERS` (a secret listing the production deployment names
and resource names), and neither may name the staging deployment.
`preview-config.mjs check` applies the same deny list to each rendered config's
`env.preview` section, and fails on a leftover placeholder, a `context.lc` or
`tex.lc` host, a service binding to any Worker other than the preview's own or
the three staging Workers named above, a Photon, Vectorize, D1 or R2 binding, or
a dataset or workflow name with the wrong suffix.

## Seed and smoke check

`functions/seed.ts` exports `preview`, an internal mutation with no arguments
that refuses unless `isIsolatedPreview()` holds. It is idempotent. It creates
the five personas `alpha` to `epsilon` (the same fixtures as the staging seed),
their personal workspaces (`beta` uses the slug `beta-preview`, because `beta`
is reserved), a shared team workspace with its members, and folder and tree
rows. It links the three texting personas' phones: alpha to +1 212 555 0101,
beta to +1 212 555 0102 and gamma to +1 212 555 0103. The seed creates no group
chat. A group chat is born from the first text its members send Tex, because
that text carries the carrier's group identifier. The seed returns workspace,
persona and phone identifiers and no secrets.

`scripts/preview-seed.mjs` then signs each persona in with a code issued by
`functions/signInCodes:issue`, and writes the seeded notes into the seeded
workspaces through public functions. Note bodies are not written by the seed
function, because they live in each workspace's object.

`scripts/preview-smoke.mjs` runs two checks and prints their timings. It sends
one simulated text from +1 212 555 0101 through the texting assistant's
simulator and waits up to 90 seconds for a reply. Then it signs alpha in and
sends one in-app Tex message the way the app does, and waits for a reply. It
exits non-zero when either check gets no reply.

## Tex Lab runs against a preview

A Tex Lab run can take `target: pr<N>`, which runs that pull request's own code
against the preview. `.github/workflows/tex-lab-run.yml` accepts it, and
`apps/convex/functions/texLabRuns.ts` refuses any other target. A preview run is
replay only: the workflow refuses record and refresh, because those call the
models live and write fixtures. Each Front door test runs once (`PREVIEW_REPEATS`
is 1). A run with no target dispatches exactly as before.

**Open point:** the Lab's run bookkeeping still goes to the production control
plane, even when the run is aimed at a preview. The run's code is the preview's
pull request, but its records are not kept in the preview. That is a gap in the
isolation described above, and it should be closed before a preview run is used
as evidence for a merge.

## Cleanup

`.github/workflows/preview-cleanup.yml` deletes a pull request's preview when
the pull request closes, or when its branch is deleted (the closed pull requests
of that branch are found and cleaned). A daily sweep at 05:23 UTC deletes any
preview whose pull request is closed, as a backstop for every other case. The
matching is exact: `scripts/preview-cleanup.mjs` deletes only names that are
`context-<kind>-pr<N>` or carry the `pr<N>-` prefix, so one preview's cleanup
cannot touch another's. The sweep warns when live previews reach
`PREVIEW_CEILING`, which is 45.

Convex expires its own preview deployments, so nothing in cleanup deletes one.

**The ceiling is 45 because of Durable Object classes.** Each preview brings its
own set of Durable Object classes, and the account allows about 500 of them. At
about 45 previews the account is close to that limit, so a preview that would
take the count past the ceiling is a problem for cleanup to surface, not for
the deploy to work around.

## What a simplification would cost

Each of these would reopen a risk this decision closed.

- **Sharing staging's data or Durable Objects with a preview** would let a
  preview's tests write to real-looking people. The fixtures would no longer be
  fictional, and a preview could show or change staging's notes.
- **Naming a preview by alias instead of a named Worker** would not work for
  Workers with Durable Objects, and a branch's Worker would be overwritten by
  the next push.
- **Dropping the `pr<N>-` prefix** would let one preview's storage collide with
  another's or with a production name, and cleanup could no longer find a
  preview's resources.
- **Widening `isIsolatedPreview` to check only `APP_ENV`** would let a copied
  production variable grant persona sign-in codes and free storage on
  production. The four legs exist for that copy.
- **Letting the guards read only the workflow's environment** would let a
  line key reach a preview through a repository secret the workflow does not
  list.
- **Letting a Lab preview run record or refresh** would call the models live
  and write fixtures from a branch that has not merged.

## What fails if it is reversed

- `apps/convex/__tests__/previewDeployment.test.ts`: "a preview deployment is
  one", "production refuses", "staging refuses", "production with APP_ENV and
  PREVIEW_NAME copied onto it refuses", "staging with preview variables copied
  onto it refuses".
- `apps/convex/__tests__/previewStorageNames.test.ts`: the managed bucket,
  search database and meaning index names; "no preview name equals a production
  or staging name for the same workspace"; "the largest preview number still
  fits every cap"; "the same id is refused on a preview, never truncated into
  another name".
- `apps/convex/__tests__/seedPreview.test.ts`, `stagingPersonas.test.ts`,
  `issuedSignInCodes.test.ts`, `phoneCheck.test.ts`, `billing/previewBilling.test.ts`
  and `texExamplesIndex.test.ts`: the widenings and their production refusals,
  named in the table above.
- `apps/convex/__tests__/controlPlane/texLabRuns.test.ts`: "a preview run is
  dispatched with its preview ... and repeats once" and "a preview runs only its
  own pull request".
- `scripts/preview-guards.test.mjs`: the silence and identity checks, the
  health-flag checks and the texts-simulator check.
- `scripts/preview-config.test.mjs`: the rendering of placeholders and the
  production-identifier guard over the `env.preview` section.
- `scripts/preview-convex-env.test.mjs`: the variables set on a preview and the
  removal of forbidden names from the deployment.
- `scripts/preview-cleanup.test.mjs`: the exact matching of preview names, so
  one preview's cleanup cannot touch another's.
- `scripts/preview-smoke.test.mjs`: the 555-01XX number check and the reply
  checks.

## Open risks

- **One Cloudflare account and one token can deploy production.** The preview
  token and the production token are the same account's, so a mistake in the
  preview workflow reaches the same account. The guards refuse production
  names, but the account boundary is shared.
- **Convex's preview cap.** A preview deployment is a Convex resource with its
  own limit, and the cap is not measured here. Previews beyond it will fail at
  the Convex step.
- **The group chat cannot be seeded from Convex.** A group chat is born from a
  carrier's group identifier, so the preview has no group chat until a text
  arrives through the simulator. Group-chat behaviour is tested only when a
  test makes one.
- **Push-to-live is unmeasured until the first run.** The timings in the pull
  request comment are the first real numbers. The one-to-two-minute target is a
  goal, not a measurement.
- **A preview does not replace the Tex replay gate.** A green preview shows that
  the backend runs and the seeded chats answer. It does not show that Tex is
  better. The replay gate in [replay-gate](./replay-gate.md) still decides a Tex
  change's merge.

## How a bot uses a preview

A bot working on a branch uses a preview like this.

1. Push the branch, and open a pull request. A draft is fine.
2. Wait for the **Preview** check to finish green.
3. Read the pull request comment written by the workflow. It names each Worker
   and the Convex preview deployment, and gives the timings. It does not print a
   host.
4. Get the origin of the texting assistant or the gateway as
   `https://<script>.<account workers.dev subdomain>`. The subdomain is not
   printed in public logs. A bot with access to the `preview` environment reads
   it from the workflow's masked values.
5. Sign in as a persona: call `functions/signInCodes:issue` on the preview's
   Convex deployment with the preview deploy key, for an address such as
   `alpha@supa.media`, and use the code it returns.
6. Text Tex through `/texts-simulator` on the texting assistant's origin, from
   +1 212 555 0101, 0102 or 0103. Those are the only numbers a preview
   recognises, and nothing reaches a real line.
7. To run Tex Lab against the branch, start a run with `target: pr<N>`. It is
   replay only, with one repeat per test.

A bot must never set a texting-line key, mail key, SMS key or payment key on a
preview. It must never point anything at a production or staging origin, or
use a production deploy key, a production identifier or a `context.lc` host. A
preview that fails a guard is reported as failed, and is not worked around by
removing the guard.
