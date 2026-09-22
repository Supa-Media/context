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
