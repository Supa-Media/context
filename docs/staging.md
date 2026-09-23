# Staging

The staging app is served at `https://staging.context.lc`, with MCP at
`https://mcp-staging.context.lc/mcp` and an EAS Update channel named `staging`.
It has a separate Convex deployment in the existing Context project.

Every merge to `main` runs `Deploy Staging`; it can also be run manually
against a selected branch. Merging never deploys production.

To release, open **Actions → Deploy to Production → Run workflow** and select
`main`. The action requires a successful staging deployment for that exact
commit, then deploys Convex, the Workers, web, router and production OTA. All
jobs use the commit fixed when the action started, even if `main` moves while
it runs. Production builds use production credentials; staging data is not
copied. A failed deployment can be retried with GitHub's **Re-run failed jobs**.

The component production workflows are reusable jobs called by this manual
action. Desktop builds/releases and native store builds/submissions remain
separate manual workflows. This release action does not build native binaries.

## Deployment configuration

The GitHub `staging` environment holds staging credentials, synced from the
`staging` fields in the Context 1Password vault. Its
`STAGING_CONVEX_DEPLOYMENT` variable identifies the backend. Before deployment,
`scripts/staging-env.mjs` requires the deploy key, frontend URL, control-plane
URL and app origin to agree with that target.

Staging has separate signing keys, storage-encryption keys, gateway credentials,
Workers, a gateway-job queue, Durable Objects and transcription rate limits.
Cloudflare deployment credentials and the EAS project can be shared because
resource names and update channels select distinct targets.

The web deployment uses the EAS `staging` alias, never `--prod`. Native builds
select the GitHub environment matching their EAS profile, and the staging
profile sets the staging MCP endpoint and sharing origin. Creating a native
binary or submitting one remains a separate manual action.

The workflow verifies the served web bundle contains the staging backend and
MCP endpoint, checks backend signing keys and MCP discovery, and probes the
transcription bindings. Publishing a bundle alone does not pass this check.

## Data and integrations

A new staging backend starts empty. Deploying code never copies production
users, workspaces, storage credentials, grants, billing records or jobs.
Connecting an existing bucket exposes its actual files to the staging code;
separate Convex databases do not isolate those writes.

Any data import needs an explicit selection of workspaces and access policy.
Do not import active sessions, OAuth grants, ingestion tickets, pending jobs,
billing sessions or connector sync state as a shortcut to a working login.
Encrypted storage credentials are bound to workspace IDs and encryption keys;
a copied row cannot be decrypted with staging's independent key.

Google and Dropbox require their staging callback URLs to be registered with
the provider before enabling their connect UI. Google mail/calendar connection
flags can remain disabled while registration is pending. Email ingestion uses
`staging.context.lc` and requires its own MX records and Email Routing rule to
`context-email-staging`; deploying the Worker does not change production MX.
Billing requires Stripe test credentials and a staging webhook; never populate
staging `appSecrets` with a live Stripe key or production provisioning tokens.

## Free managed storage

Workspace owners can create managed buckets on staging without entering Stripe
or supplying a card. The normal workspace limits, tenant checks, credential
encryption and bucket verification still apply. Staging creates its own buckets;
it does not connect or copy production workspace data. This is free to testers;
Context still pays Cloudflare for the storage and operations.

The backend requires `APP_ENV=staging`, the staging app origin, and its own
platform-provided `CONVEX_CLOUD_URL` to match `STAGING_CONVEX_DEPLOYMENT` before
allowing the bypass. The staging sync sets these deployment selectors; a client
flag or request origin cannot enable it. Ordinary production owners still need
payment. Selected services activate through the existing test activation path,
with a distinct staging audit event; fast search remains an explicit opt-in.

Every managed bucket created by staging is named `staging-ctx-<workspaceId>`;
production retains `ctx-<workspaceId>`. Inspect and select only the `staging-`
prefix when cleaning up test storage. Deleting a bucket leaves its workspace
binding in Convex, so the app may report missing storage afterwards.
A compact Staging pill beside the console storage badge identifies the environment.
Storage activation screens warn that data may be deleted at any time and must
never be the only copy of vital information.

## Seeded personas

Use the normal email login at `https://staging.context.lc` and enter `000000`.
Only these exact five addresses get this behavior, only on the isolated staging
backend; normal email delivery is suppressed for these fixture logins.
They have ordinary workspace permissions, with no admin or production privileges.

| Email | Persona | Personal workspace | Lumio | Maison Solenne | Common Ground |
| --- | --- | --- | --- | --- | --- |
| alpha@supa.media | Alpha Morgan, product founder and campaign collaborator | @alpha | Owner | Editor | None |
| beta@supa.media | Beta Chen, freelance product and program operator | None | Editor | Read-only member | Editor |
| gamma@supa.media | Gamma Ellis, pilot reviewer and volunteer | None | Read-only member | None | Read-only member |
| delta@supa.media | Delta Brooks, creative director and nonprofit lead | @delta | None | Owner | Owner |
| epsilon@supa.media | Epsilon Reed, new collaborator | None | Pending editor invitation | None | None |

Lumio is a fictional tech company, Maison Solenne a fashion house, and Common
Ground a nonprofit. Each shared workspace has eleven sample notes covering active
projects, tasks, meeting decisions, reference material and archived work, plus
an owner-only leadership note among those eleven. Each personal workspace has four
private notes. All figures, suppliers and people are synthetic. The storage
onboarding scaffold adds its usual root files and folder guides.

Run **Actions → Seed Staging Personas** after deploying this version to staging.
The workflow validates the deployment key and URL before making any changes.
Its internal preparation mutation independently checks the server environment,
app origin and platform deployment URL, and refuses name collisions or unrelated
members. Storage provisioning, note writes and verification use normal user APIs.

Check **reset** to restore the 41 fixture notes, fixture roles and Epsilon's
seven-day invitation. Reset overwrites those known notes and removes fixture
memberships that are absent from the matrix; it does not delete extra notes,
other workspaces, storage buckets, or connected integrations. Extra workspaces
created by testers will fail the exact workspace-list verification until cleaned
up. Ordinary seeding fills missing notes and preserves existing fixture text.
Neither operation runs automatically when code is deployed.

Every run verifies all five OTP logins, storage, exact membership lists, denied
cross-workspace reads, owner-only notes, a read-only write refusal, an editor save,
and invitation acceptance. It restores Epsilon to an unjoined account with a new
pending invitation before finishing, and signs out the verification sessions.

The auth patch namespaces the fixed code by email before storage/verification:
Convex Auth indexes verification codes globally, so storing the same hash five
times would break simultaneous logins. Expiry, single use and verification rate
limits remain in effect. Tests cover production/mismatched deployment rejection,
non-allowlisted addresses, concurrent outstanding codes and cross-address misuse.

The operator seed claims the reserved `@alpha` name for its staging persona.
Ordinary registration and production reservation rules stay in effect.
