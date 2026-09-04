# Context gateway — setup

`apps/mcp` is the Context MCP gateway: one Cloudflare Worker that serves a
customer-owned bucket of markdown notes over MCP. It holds no database and no
bucket of its own. Every request carries an OAuth 2.1 access token, the control
plane resolves that token to a workspace, and the storage credential for that
workspace is fetched per request.

Two audiences, and you probably want only one of them:

- **Connecting an AI client** to a gateway that is already running — no deploy,
  no keys, nothing to paste but a URL. Start at [Connect an AI client](#connect-an-ai-client).
- **Self-hosting the gateway** over your own bucket. Start at
  [Self-host the gateway](#self-host-the-gateway). You will need a control plane
  (`apps/convex`) as well; the gateway refuses every request without one.

There is no static-token access path any more. `PRIVATE_TOKEN`, `TEAM_TOKEN`,
`PUBLIC_TOKEN` and `INBOX_TOKEN` are gone — not deprecated, gone — and no
environment variable grants access to anything.

---

## Connect an AI client

Paste the URL into the client. That is the whole procedure.

```
https://<host>/mcp              your default context
https://<host>/@<slug>/mcp      a named context
https://<host>/<slug>/mcp       the same thing without the @
```

The client then does the rest by itself:

1. It POSTs `/mcp`, gets a `401` with a `WWW-Authenticate` challenge naming the
   resource metadata URL, and fetches it (RFC 9728).
2. That document names the authorization server; the client fetches
   `/.well-known/oauth-authorization-server` (RFC 8414).
3. It registers itself dynamically (RFC 7591) at `/oauth/register`.
4. It opens `/oauth/authorize` in a browser. The gateway validates the request
   and hands the browser to the control plane's own app, where **you** sign in,
   choose a context, and approve. The gateway never sees a password or a session
   cookie.
5. It exchanges the authorization code at `/oauth/token` using PKCE (`S256`
   only — `plain` is neither advertised nor accepted).

Examples:

- **Claude Code:**
  ```sh
  claude mcp add --transport http context https://<host>/mcp
  ```
  No `--header`. The browser flow starts on first use.
- **claude.ai / ChatGPT / Cursor:** add it as a custom MCP connector with the
  same URL and complete the sign-in when prompted.

### The slug in the URL is a selector, never a boundary

`/@seyi/mcp` provides **no isolation whatsoever**. Cloudflare routes every path
on a hostname to the same Worker, and isolates are reused across paths exactly
as they are across requests. The OAuth grant decides what a connection may
reach; the slug only *selects* among the workspaces that grant already covers,
and a slug the grant does not cover is refused identically whether or not it
names a real context — otherwise the path would be an existence oracle for every
name in a global namespace.

What it is actually for:

- **Tenant-scoped cache keys by construction.** The Cache API keys on the full
  URL, so any future caching of non-secret data cannot cross-hit between tenants
  by accident.
- **Observability.** Logs and analytics segment per tenant without parsing a
  token.
- **Legibility.** People see this URL in their client settings, and
  `<host>/@seyi/mcp` reads as theirs.

### If the client cannot set headers

```
https://<host>/t/<access token>/mcp
```

This is a compatibility fallback and nothing more. The value in the path is an
**OAuth-issued access token**, not a shared secret: it is resolved by exactly the
same code as a header token, yields exactly the same grant, and confers exactly
the same authority. It has never been the security boundary.

A token in a URL lands in browser history, proxy logs, and referrer headers. Use
the header form unless the client genuinely cannot, and revoke the grant if you
suspect the URL leaked.

### What a connection may do

Scopes are requested by the client and approved by you:

| Scope             | Allows                                                     |
| ----------------- | ---------------------------------------------------------- |
| `context:read`    | read every note this connection is allowed to see           |
| `context:write`   | create, update, move, and archive notes (implies capture)   |
| `context:capture` | drop a raw capture into `0-inbox/` and nothing else         |

`POST /inbox` requires `context:capture`. A read-only grant is not *shown* the
write tools in `tools/list` — advertising tools it will then be refused makes a
connected client look broken — and calling one anyway is still refused, because
the listing is a courtesy and the call check is the control.

Two things narrow a connection independently, and neither implies the other: the
scopes on the grant, and the membership role. A read-only grant issued to an
owner still cannot write, and a full-scope grant issued to a read-only member
cannot write either — a grant cannot confer authority the membership never had.

### What a connection may see

Privacy tier comes from the membership role in the workspace:

| Role               | Tier      | Sees                                            |
| ------------------ | --------- | ----------------------------------------------- |
| `owner`            | `private` | everything, including notes marked private       |
| `editor`, `member` | `team`    | team-visible notes only                          |

`private` means "sees everything in this context", so only the person whose
private notes these are gets it. An `editor` can write and a `member` cannot,
but neither is that person.

There is no anonymous or internet-public tier. `team` means named people the
owner granted access to.

### Endpoints

| Endpoint                                        | Method | Notes                                        |
| ----------------------------------------------- | ------ | -------------------------------------------- |
| `/mcp`, `/@<slug>/mcp`, `/<slug>/mcp`           | POST   | MCP streamable HTTP; needs `context:read`     |
| `/t/<token>/mcp`                                | POST   | header-less fallback for the same thing       |
| `/inbox`                                        | POST   | capture into `0-inbox/`; needs `context:capture` |
| `/.well-known/oauth-protected-resource[/…]`     | GET    | RFC 9728; also served under `/@<slug>/`       |
| `/.well-known/oauth-authorization-server[/…]`   | GET    | RFC 8414                                      |
| `/oauth/register`                               | POST   | RFC 7591 dynamic client registration          |
| `/oauth/authorize`                              | GET    | authorization code + PKCE (`S256`)            |
| `/oauth/token`                                  | POST   | code exchange and refresh                     |
| `/oauth/revoke`                                 | POST   | RFC 7009, one grant at a time                 |
| `/granola-webhook`                              | POST   | single-deployment ingestion only              |

---

## Self-host the gateway

Someone must be able to clone this repo, deploy the gateway, point it at their
own bucket, and have a working context without us. These are those steps.

### 1. Prerequisites

- Node.js 18+ (`node -v`)
- `npm i -g wrangler`, then `wrangler login` — check `wrangler whoami` names the
  account you meant before going further
- A running control plane (`apps/convex`), because the gateway asks it who every
  caller is and where their bucket is
- A bucket: R2, AWS S3, Backblaze B2, Wasabi, or anything else with an
  S3-compatible API

### 2. Configure the Worker

`wrangler.toml` in this directory is the product / self-host config. It binds no
bucket by default and that is deliberate — storage arrives per request from the
control plane. Read its comments before editing; the cron and native-binding
sections are commented out because they are self-host-only.

Set `PUBLIC_ORIGIN` in `[vars]` to the origin you will serve on. Every URL in
both discovery documents is built from it, including the authorization endpoint
a client sends a person's browser to, so a wrong value is a security problem and
not a cosmetic one. Unset, discovery URLs fall back to the request's `Host`
header, which is fine for `wrangler dev` and a workers.dev URL and wrong behind
anything that rewrites `Host`. That fallback applies to discovery URLs only —
the browser-origin allowlist never uses it, for the reason under
`ALLOWED_ORIGINS` below.

### 3. Set the two required secrets

```sh
wrangler secret put CONTROL_PLANE_URL   # https://<deployment>.convex.site, no trailing slash
wrangler secret put GATEWAY_SECRET      # the same value the control plane expects
```

Without both, the worker refuses every request rather than degrading into some
other access path. `CONTROL_PLANE_URL` must be `https` (the sole exception is the
offline test host used by the suite).

**`GATEWAY_SECRET` is not sufficient on its own to fetch a storage credential,
and must never become sufficient.** A binding is opened with two independent
proofs: the gateway secret, which proves the caller is the gateway, *and* the end
user's own OAuth access token, forwarded verbatim, which proves a real person
authorized this context and their grant is live right now. The control plane
derives the workspace from that grant — the gateway does not get to name the
workspace it wants. So a leaked gateway secret on its own yields nothing, and the
blast radius of a fully compromised gateway is bounded by "workspaces whose users
are connecting right now", not "every workspace that ever existed". The full
reasoning is at the top of `src/controlPlane.js`; do not simplify it away.

### 4. Bind storage

Two shapes, and the first is the normal one:

- **S3-compatible (any provider, including R2's S3 API).** Register the bucket
  and a scoped credential with the control plane; the gateway signs requests
  with it per request. Nothing goes in `wrangler.toml`. Scope the credential to
  the one bucket, and rotate it on your own schedule — you can revoke it without
  asking anyone.
- **Native R2 binding (self-host only).** Add an `[[r2_buckets]]` binding *and*
  list its name in `NATIVE_BINDINGS`. Both are required: the allowlist is what
  stops a control plane that is compromised or pointed at the wrong row from
  naming any R2 bucket the Worker can see.

### 5. Deploy

```sh
wrangler deploy
```

### 6. Smoke test (do not skip)

```sh
curl -s  https://<host>/.well-known/oauth-protected-resource/mcp
curl -s  https://<host>/.well-known/oauth-authorization-server
curl -si -X POST https://<host>/mcp -H 'Content-Type: application/json' -d '{}' | head -20
```

Expect, in order: a metadata document naming your origin as the authorization
server; a metadata document listing `S256` under `code_challenge_methods_supported`
and `none` / `client_secret_post` as token endpoint auth methods; and a bare
`401` carrying `WWW-Authenticate: Bearer … resource_metadata="…"`. A `200` on
that last one, or a `WWW-Authenticate` on anything other than a `401`, means
clients will silently decide there is no authorization server and never start a
flow.

Then run a real flow:

```sh
npx @modelcontextprotocol/inspector
```

Connect to `https://<host>/mcp` over Streamable HTTP and complete the browser
sign-in. Then check the two properties that matter:

1. **Privacy.** As an `owner`, `orient` shows the private index. Reconnect as an
   `editor` or `member` of the same context: `orient` must not include it, and
   `list_notes` and `search_notes` must not reveal private filenames.
2. **Tenancy.** Ask for a context your grant does not cover
   (`https://<host>/@someone-else/mcp`). It must be refused with no detail, and
   refused identically to a slug nobody has ever registered.

If either check fails, stop and fix it before connecting anything.

The suite covers both properties offline:

```sh
node test/test.mjs        # or: pnpm test
```

### 7. Single-deployment ingestion (optional)

The calendar cron and the Granola webhook are the two features with no user
behind them — no OAuth token arrives on a cron tick — so they write to one
bucket bound directly to the Worker instead of going through the per-request
credential path. That only makes sense when you host the gateway over your own
single context. Bind it:

```toml
[[r2_buckets]]
binding = "LOCAL_CONTEXT_BUCKET"
bucket_name = "my-context"
```

`LOCAL_CONTEXT_BUCKET` is not an access path and no MCP session can reach it.
Anything a *caller* can reach goes through the per-request store, which requires
a live grant. On a multi-tenant deployment it is unset, the webhook answers
`404`, and the cron returns immediately.

`LOCAL_CONTEXT_ROOT_PREFIX` is optional and applied inside the storage adapter.

**Calendar.** Google Calendar → Settings → *your calendar* → "Integrate
calendar" → **Secret address in iCal format**, then:

```sh
wrangler secret put CALENDAR_ICS_URL
```

Uncomment the `[triggers]` block in `wrangler.toml` and deploy. The cron
rewrites `2-areas/calendar/next-14-days.md` daily at 05:00 UTC. The
zero-dependency parser expands common daily, weekly, monthly and yearly
recurrence rules, including exclusions and moved or cancelled instances. Treat
the note as useful planning context, not a substitute for the source calendar:
unusually complex rules and timezone conversion can still be approximate.

**Granola.** Granola Business/Enterprise sends first-party webhooks:

1. Granola → **Settings → Connectors → Webhooks** → **Set up a webhook**.
2. Endpoint: `https://<host>/granola-webhook`.
3. Select the `personal` scope and the `note.generated`, `note.edited` and
   `note.access_granted` events. Optionally filter to a Granola folder.
4. Copy the one-time signing secret and a compatible personal API key from the
   confirmation dialog.
5. `wrangler secret put GRANOLA_WEBHOOK_SECRET` and
   `wrangler secret put GRANOLA_API_KEY`, then deploy.
6. Send Granola's test event. The note appears privately under `0-inbox/granola/`.

The Worker verifies Standard Webhooks HMAC signatures and rejects deliveries
more than five minutes old. It acknowledges accepted events quickly, fetches the
full summary through Granola's API, keeps note edits at a stable path with
history, and retries pending failures on the daily scheduled run. Neither Granola
secret is ever written into a note or an audit record.

### Environment variables

| Name                        | Required | Kind   | What it is                                                        |
| --------------------------- | -------- | ------ | ----------------------------------------------------------------- |
| `CONTROL_PLANE_URL`         | yes      | secret | Convex HTTP-actions origin, no trailing slash                      |
| `GATEWAY_SECRET`            | yes      | secret | proves "this caller is the gateway"; not sufficient on its own     |
| `PUBLIC_ORIGIN`             | in prod  | var    | the gateway's public origin, used in every discovery document      |
| `ALLOWED_ORIGINS`           | no       | var    | browser origins allowed to reach `/mcp` and `/inbox` (see below)   |
| `NATIVE_BINDINGS`           | no       | var    | self-host only; allowlist of Worker binding names                  |
| `LOCAL_CONTEXT_BUCKET`      | no       | binding| single-deployment ingestion only; unreachable from any request     |
| `LOCAL_CONTEXT_ROOT_PREFIX` | no       | var    | root prefix for that bucket, applied inside the adapter            |
| `CALENDAR_ICS_URL`          | no       | secret | calendar cron                                                      |
| `GRANOLA_API_KEY`           | no       | secret | reads Granola note contents                                        |
| `GRANOLA_WEBHOOK_SECRET`    | no       | secret | verifies Granola deliveries                                        |

#### `ALLOWED_ORIGINS`

MCP requires a server to validate the `Origin` header on the Streamable HTTP
transport, because a page in a victim's browser that rebinds a hostname to this
gateway would otherwise reach a session that can read and write their whole
context. Set this to the browser origins you serve a console from, comma- or
space-separated:

```toml
ALLOWED_ORIGINS = "https://console.example.com"
```

Matching is exact — scheme, host and port, no wildcards. This deployment's own
origin is allowed without being listed **when `PUBLIC_ORIGIN` declares it**. It
is deliberately not derived from the request's `Host`: under that fallback the
allowlist would be whatever a caller claimed, so a rebinding page sending
`Host: attacker.example` and `Origin: https://attacker.example` would match
itself. If you leave `PUBLIC_ORIGIN` unset and serve a browser console from the
gateway's own origin, list that origin here.

**Leaving it unset is safe and is the right default.** Claude Desktop, Codex
CLI, Claude Code and the MCP SDKs are not browsers and send no `Origin` at all;
a request without one is always served. The setting only decides which *browser*
origins may connect, so an unset allowlist means "non-browser clients only".

---

## Obsidian (desktop + phone)

The bucket is yours, so sync it directly. Nothing here goes through the gateway.

1. Create a **new vault**, separate from your human vault.
2. Mint a storage credential scoped to that one bucket — for R2: dashboard → R2
   → **Manage R2 API Tokens** → *Object Read & Write*, scoped to the bucket. Note
   the Access Key ID, Secret Access Key, and S3 endpoint.
3. Install the **Remotely Save** community plugin in that vault:
   - Service: S3-compatible
   - Endpoint, region and bucket from step 2
   - **End-to-end encryption: OFF** — the Worker has to be able to read the files
   - Sync on save / interval: your taste
4. First sync pulls the layout down. Repeat on mobile.
5. Optional: exclude `.history/` in Remotely Save's ignore settings. Nothing
   writes there any more, but a bucket connected before this change can still
   hold a large tree of old snapshots you would otherwise sync down.

Folder defaults and exact-note exceptions live in `privacy.md` at the root of the
bucket — private, and visible in Obsidian. Editing `visibility:` or `scope:` in a
note's frontmatter does **not** change access: frontmatter is descriptive, and
`set_visibility` / `set_folder_visibility` are the controls. A `team` connection
must not be able to list, search, read, or infer the filenames of private
notes — even when private and team notes sit side by side in the same folder.

---

## Capture

`POST /inbox` with a `context:capture` grant. Plain text works:

```
POST https://<host>/inbox
Authorization: Bearer <access token>

The text to capture
```

Captures land privately in `0-inbox/`. For structured captures, send JSON;
`text` is required and the rest are optional:

```json
{
  "title": "Weekly leadership sync",
  "text": "The enhanced note or transcript",
  "source": "example-provider",
  "external_id": "provider-note-id",
  "source_url": "https://provider.example/note/id",
  "source_created_at": "2026-08-21T15:00:00Z",
  "attendees": ["Ada", "Grace"],
  "metadata": { "meeting_type": "weekly" }
}
```

`external_id` makes retries idempotent: the same source and id returns the
existing inbox path instead of creating a duplicate. Provider metadata never
affects note visibility.

An automation that only needs to file things should hold a capture-only grant.
It records in the audit trail as `inbox`, distinct from a person filing something
by hand with a full connection.

---

## Storage adapter

All storage goes through a `ContextStore` (`src/store/`), never a binding
directly:

| Adapter   | File              | Use                                                                   |
| --------- | ----------------- | --------------------------------------------------------------------- |
| `S3Store` | `src/store/s3.js` | any S3-compatible endpoint — R2's S3 API, AWS S3, Backblaze B2, Wasabi |
| `R2Store` | `src/store/r2.js` | a native Cloudflare R2 binding (self-host only, allowlisted)           |

`storeForSession` in `src/session.js` is the only place in the worker that turns
a workspace into a bucket, and the only place a storage credential exists.
Everything above it works against the interface and never learns which provider,
bucket, or prefix it is talking to.

The credential is fetched per request and **never cached across requests**. A
Worker isolate is reused across requests and across tenants, so a module-level
map of workspace → decrypted secret is one wrong cache key away from signing
tenant A's request with tenant B's credential — silently and totally. The price
is two sequential control-plane round trips before any bucket I/O, and it is
paid deliberately.

Three rules the adapters exist to protect:

- **Keys are never rewritten.** A note lives at `1-projects/foo.md` in the
  customer's bucket, full stop. A customer-chosen `rootPrefix` is applied inside
  the adapter and stripped back off; nothing above it ever sees the prefix. A
  bucket that already looks like a context connects with zero migration, and
  Obsidian keeps working. (One documented exception: a list `cursor` is an opaque
  backend token that still encodes the prefix. It never leaves the adapter's
  pagination loop — see the comment on `stripListResult`.)
- **Keys are validated, never normalized.** `.`, `..`, empty segments, control
  characters and backslashes are rejected at the adapter boundary, identically
  for both adapters. Silently rewriting `a/../b.md` would escape the `rootPrefix`
  — and, path-style, the bucket itself — with a perfectly valid signature.
- **Conditional writes are verified, not assumed.** `put(key, value, { onlyIf: {
  etagMatches } })` is what makes every etag check in the tools real. R2 and AWS
  S3 honour `If-Match`; **B2 and Wasabi accept the header and ignore it.** Call
  `probeStore(store)` at connect time: it writes a temp object under
  `.context-probe/` and proves all three halves of the contract — a wrong
  `If-Match` is rejected, a correct one is accepted, and a now-stale one is
  rejected again — then cleans up and returns a structured result. All three
  matter: a backend that only checks etag *shape* passes the first two and still
  does last-writer-wins on real conflicts. `conditionalWrite.mismatch: true`
  means the backend claims a capability it does not have — degrade honestly
  rather than losing conflict detection silently.

`S3Store` addresses buckets **path-style by default**. Virtual-hosted addressing
(`<bucket>.<host>/<key>`) is opt-in with `forcePathStyle: false`. If the
endpoint's first host label happens to equal the bucket name — `s3` on
`s3.wasabisys.com`, or an account id on `<account>.r2.cloudflarestorage.com` —
the constructor throws and asks for an explicit `forcePathStyle`, because
guessing wrong there silently sends reads and writes to a *different bucket*.

---

## Operations

- **Audit privacy:** read `privacy.md` in Obsidian or through an owner
  connection. It holds folder defaults and exact-note exceptions. Use
  `scope_info(path)` to check a note's effective visibility.
- **Team write discovery:** call `scope_info`, optionally with a proposed path.
  Team output lists only its writable surface and never names private notes or
  overrides. An owner's path check returns the effective `private` or `team`
  visibility; a team path check reports only the folder default, so it cannot be
  used as a private-note existence oracle.
- **New folders:** folders are implicit. Writing `2-areas/apps/example.md`
  creates `2-areas/apps/` when `2-areas` is team-writable.
- **Mixed folders:** notes created by an owner connection default to private;
  notes created by a team connection default to team. An owner can pass
  `visibility: private` or `visibility: team` to `write_note`; publishing to team
  requires `confirm_team_publish: true`. Updates preserve existing visibility when
  omitted. `set_visibility(path, visibility, expected_etag)` changes an existing
  note without moving it, and moves preserve effective privacy. Frontmatter alone
  never grants or removes access.
- **Correct destination is not writable:** use `propose_note`; an owner reviews
  it with `list_proposals`, `read_proposal` and `review_proposal`.
- **Cleanup:** a team connection archives team content into the team archive,
  where it stays team-visible and recoverable. Owner archives safely tighten to
  private. Explicit private visibility is never loosened.
- **Conversation history:** `archive_chat` stores user-visible transcripts in
  `4-archive/chat-history/<platform>/<ISO timestamp>.md`, defaulting to the
  connection's own tier. A team connection that explicitly asks for private
  storage creates a hidden proposal for owner approval instead of gaining private
  write access.
- **Transcript completeness:** agents label archives `full-visible-transcript`,
  `available-context`, or `summary`. The gateway can store what a client sends
  but cannot recover turns the client omitted or compacted. Never archive hidden
  prompts, internal reasoning, credentials, or raw tool logs.
- **Large reorganizations:** dry-run `move_notes` or `move_folder` first. An
  applied `move_notes` requires the current etag for every source.
- **Rollback a note:** **enable object versioning on your bucket** — this is the
  only thing standing between you and a bad overwrite, and it is yours to turn
  on. R2, S3, B2 and Wasabi all support it; the gateway keeps no second copy of
  your notes and cannot restore one for you. Versioning also captures the writes
  Obsidian and rclone make directly, which the gateway never sees. With it off,
  an overwrite is final.
- **Disconnect a client:** revoke its grant. `/oauth/revoke` kills exactly the
  one grant that token belongs to and touches nothing else — sibling grants for
  the same person and context from a different AI client keep working, which is
  the entire point of per-client grants. Revoking through the dashboard has the
  same effect, and removing someone from a workspace cuts off their already-issued
  clients at the next request.
- **Rotate a storage credential:** do it at your provider and update the binding
  in the control plane. The gateway holds nothing to rotate — it reads the
  credential fresh on every request, so the change takes effect immediately with
  no deploy.
- **Backup:** the Obsidian vault on each device is already a full local copy. For
  a paper trail, `git init` inside the local vault and commit occasionally.
