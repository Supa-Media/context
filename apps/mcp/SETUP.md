# Brain — setup

Everything below runs **on your own laptop, against your personal Cloudflare
account**. Never paste the personal-access token — or run these steps — from an
org-administered tool or shared session.

Total time: ~15 min deploy + ~20 min connecting tools.

---

## 1. Prerequisites

- Node.js 18+ (`node -v`)
- `npm i -g wrangler`
- `wrangler login` → **the browser window must log into your PERSONAL account.**
  Verify before going further:

  ```sh
  wrangler whoami        # account listed must be the personal one
  ```

  (If you also use an org Cloudflare account in this browser, use a private
  window for the login.)

## 2. Create the bucket

```sh
wrangler r2 bucket create brain
```

## 3. Mint and store the tokens

```sh
openssl rand -hex 32   # run 3× → PERSONAL, TEAM, INBOX tokens
```

Save all three in your password manager, labeled clearly. Then:

```sh
cd brain-scaffold
wrangler secret put PRIVATE_TOKEN   # paste personal token (compatibility name)
wrangler secret put TEAM_TOKEN      # paste team/shared token
wrangler secret put INBOX_TOKEN     # paste inbox token
# Native Granola sync (optional; values come from Settings → Connectors → Webhooks):
wrangler secret put GRANOLA_API_KEY
wrangler secret put GRANOLA_WEBHOOK_SECRET
```

## 4. Deploy and seed

```sh
wrangler deploy                     # prints your permanent URL: https://brain.<subdomain>.workers.dev
bash upload-skeleton.sh             # uploads index.md, privacy.md, PARA folders
```

## 5. Smoke test (do not skip)

```sh
npx @modelcontextprotocol/inspector
```

Connect to `https://<your-worker-url>/mcp` (transport: "Streamable HTTP",
header `Authorization: Bearer <PERSONAL_TOKEN>`) and:

1. Call `orient` → you should see the manifest **including** the personal index.
2. Reconnect with the TEAM token → `orient` must NOT include the private
   index, and `list_notes` must not show `index-private.md`.
3. With personal access, create one test note with `visibility: private` and one
   with `visibility: team, confirm_team_publish: true` in the same folder.
   Reconnect with team access and verify that only the team note can be listed
   or read. Archive both with the personal connection when finished.

If check 2 fails, stop and fix before connecting any shared tool.

## 6. Calendar feed (optional, recommended)

Google Calendar → Settings → *your calendar* → "Integrate calendar" →
**Secret address in iCal format** (starts `https://calendar.google.com/calendar/ical/…/private-…/basic.ics`).

```sh
wrangler secret put CALENDAR_ICS_URL   # paste the secret URL
```

The cron rewrites `2-areas/calendar/next-14-days.md` daily at 05:00 UTC.
Trigger one run now to verify: `wrangler triggers deploy` then check the
Worker's dashboard, or just wait for the first tick. The zero-dependency
parser expands common daily, weekly, monthly, and yearly recurrence rules,
including exclusions and moved/cancelled instances. Treat the note as useful
planning context, not a substitute for the source calendar: unusually complex
rules and timezone conversion can still be approximate.

## 7. Obsidian (desktop + phone)

1. Create a **new vault** (separate from your human vault), e.g. "Brain".
2. Cloudflare dashboard → R2 → **Manage R2 API Tokens** → create token:
   *Object Read & Write*, **scoped to only the `brain` bucket**. Note the
   Access Key ID, Secret Access Key, and your account's S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`).
3. Install the **Remotely Save** community plugin in that vault:
   - Service: S3-compatible
   - Endpoint: the URL above · Region: `auto` · Bucket: `brain`
   - Access key / secret: from step 2
   - **End-to-end encryption: OFF** (the Worker must be able to read the files)
   - Sync on save / interval: your taste
4. First sync pulls the skeleton down. Repeat on Obsidian mobile.
5. Optional: in Remotely Save's ignore settings, exclude `.history/` to keep
   version snapshots out of your vault view.

Folder rules provide the team-write surface, and a server-enforced per-note ACL
can make an individual note private. Moving a note preserves its explicit
private visibility. Editing
`visibility:` or `scope:` inside Markdown does **not** change access by itself;
use `set_visibility` through a personal connection. A team connection must not
be able to list, search, read, or infer the filenames of private notes—even when
private and team notes are side by side in the same Obsidian folder.

## 8. Connect AI tools

Choose access for each connection, not merely for an app brand or device:

- **Personal access** (`PRIVATE_TOKEN`, retained as an internal compatibility
  name): for a connection only you control and trust with private details.
- **Team access** (`TEAM_TOKEN`; legacy deployments may also accept
  `PUBLIC_TOKEN` as the same team-level credential): for shared subscriptions,
  shared remote control, teammates, and any connection whose configuration or
  conversations may be visible to someone else.

There is no anonymous or internet-public tier. “Team” means visible to anyone
holding the shared Brain credential, across any team you belong to. More
specific team tiers may be added later; they are not implemented now. When
unsure, use team access.

- **Claude Code (your machine):**
  ```sh
  claude mcp add --transport http brain https://<worker-url>/mcp \
    --header "Authorization: Bearer <PERSONAL_TOKEN>"
  ```
- **claude.ai / Claude apps** (custom connector; if the UI has no header
  field, use the token-in-path URL):
  `https://<worker-url>/t/<PERSONAL_TOKEN>/mcp`
- **ChatGPT / Cursor / others:** same pattern — header if supported, else the
  `/t/<token>/mcp` form, choosing the token by the trust question above.
- **Shared/org tools:** `https://<worker-url>/t/<TEAM_TOKEN>/mcp` — never the
  personal token, no exceptions.

Path-style tokens can end up in server logs; that's the accepted trade-off for
clients without header support. Rotation is cheap (below), so rotate on doubt.

## 9. Capture (optional)

iOS Shortcut ("Send to Brain"): Share Sheet → Get text from input →
**Get Contents of URL**: POST `https://<worker-url>/inbox`, header
`Authorization: Bearer <INBOX_TOKEN>`, request body = the text. Captures land
in `0-inbox/` (private). Zapier/Make/n8n can hit the same endpoint.

For structured captures, send JSON. `text` is required; the remaining fields
are optional:

```json
{
  "title": "Weekly leadership sync",
  "text": "The enhanced note or transcript",
  "source": "granola",
  "external_id": "provider-note-id",
  "source_url": "https://provider.example/note/id",
  "source_created_at": "2026-08-21T15:00:00Z",
  "attendees": ["Seyi", "Alex"],
  "metadata": { "meeting_type": "weekly" }
}
```

`external_id` makes retries idempotent: the same source + ID returns the
existing inbox path instead of creating a duplicate. Structured captures remain
private in `0-inbox/`; provider metadata does not affect note visibility.

### Native Granola webhook

Granola Business/Enterprise can send first-party webhooks, avoiding Zapier:

1. In Granola, open **Settings → Connectors → Webhooks** and choose
   **Set up a webhook**.
2. Set the endpoint to `https://<worker-url>/granola-webhook`.
3. Select the `personal` scope and the `note.generated`, `note.edited`, and
   `note.access_granted` events. Optionally filter to a Granola folder.
4. Copy the one-time signing secret and create/copy a compatible personal API
   key from Granola's confirmation dialog.
5. Store them with `wrangler secret put GRANOLA_WEBHOOK_SECRET` and
   `wrangler secret put GRANOLA_API_KEY`, then deploy.
6. Send Granola's test event. The resulting note appears privately under
   `0-inbox/granola/`.

The Worker verifies Standard Webhooks HMAC signatures and rejects deliveries
more than five minutes old. It acknowledges accepted events quickly, fetches the
full summary through Granola's API, keeps note edits at a stable path with
history, and retries pending failures during the daily scheduled run. Neither
Granola secret is ever written into a note or audit record.

## 10. Seed the brain

Open your first personal-access Claude session and say:

> "Interview me about my active projects, areas of responsibility, and goals,
> and populate the brain. Before every write, choose `private` or `team`; use
> `private` for personal or sensitive details and confirm any team publication."

Folder defaults and exact-note exceptions live in the private, Obsidian-visible
`privacy.md`. Use `set_visibility` for safe conditional updates; frontmatter
labels are descriptive, not access control.

---

## Storage adapter

All storage goes through a `ContextStore` (`src/store/`), never through a
binding directly:

| Adapter   | File              | Use                                                                   |
| --------- | ----------------- | --------------------------------------------------------------------- |
| `R2Store` | `src/store/r2.js` | a Cloudflare R2 binding (what this deployment uses)                    |
| `S3Store` | `src/store/s3.js` | any S3-compatible endpoint — R2's S3 API, AWS S3, Backblaze B2, Wasabi |

`src/index.js` builds the store in exactly one place (`storeForRequest`), so
pointing a deployment at a different bucket is a change there and nowhere else.
`S3Store` signs its own requests with AWS Signature V4 using `fetch` and Web
Crypto — no SDK, no dependencies.

Two rules the adapters exist to protect:

- **Keys are never rewritten.** A note lives at `1-projects/foo.md` in the
  customer's bucket, full stop. If a customer configures a `rootPrefix`, the
  adapter applies it and strips it back off; nothing above the adapter ever sees
  it. A bucket that already looks like a context connects with zero migration,
  and Obsidian/Remotely Save keeps working.
- **Conditional writes are verified, not assumed.** `put(key, value, { onlyIf:
  { etagMatches } })` is what makes every etag check in the tools real. R2 and
  AWS S3 honour `If-Match`; **B2 and Wasabi accept the header and ignore it.**
  Call `probeStore(store)` at connect time: it writes a temp object under
  `.context-probe/`, tries to overwrite it with a deliberately wrong `If-Match`,
  cleans up, and returns a structured result. `conditionalWrite.mismatch: true`
  means the backend claims a capability it does not have — degrade honestly
  rather than losing conflict detection silently.

## Operations

- **Audit privacy** = read `privacy.md` in Obsidian or through personal MCP
  access. It contains both folder defaults and exact-note exceptions. Use
  `scope_info(path)` to audit a note's effective visibility.
- **Team write discovery:** call `scope_info`, optionally with a proposed path.
  Team output lists only its writable surface and never names private notes or
  overrides. A personal path check returns effective `private` or `team`
  visibility; a team path check reports only the folder default so it cannot be
  used as a private-note existence oracle.
- **New folders:** folders are implicit. Writing
  `2-areas/apps/example.md` creates `2-areas/apps/` when `2-areas` is team-writable.
- **Mixed folders:** new notes created with personal access default to private;
  new notes created with team access default to team. A personal connection can
  pass `visibility: private` or `visibility: team` to `write_note`; publishing a
  new or existing note to team requires `confirm_team_publish: true`. Updates
  preserve existing visibility when omitted. Use `set_visibility(path,
  visibility, expected_etag)` to change an existing note without moving it.
  Moving a note preserves effective privacy. A personal connection can publish
  one exact team exception inside a private-default folder only with explicit
  confirmation. Frontmatter alone never grants or removes access.
- **Correct destination is not writable:** use `propose_note`; a personal
  connection reviews it with `list_proposals`, `read_proposal`, and
  `review_proposal`.
- **Cleanup:** a team connection archives team content into the team archive,
  where it remains team-visible and recoverable. Personal access archives
  safely tighten to private. Explicit private visibility is never loosened.
- **Conversation history:** `archive_chat` stores user-visible transcripts in
  `4-archive/chat-history/<platform>/<ISO timestamp>.md`.
  Privacy defaults to the credential: personal Codex/ChatGPT connections archive
  privately; team Claude/Notion connections archive at team visibility. Personal
  access can deliberately publish to the team tier. A team connection explicitly
  asked for private storage creates a hidden proposal for personal approval
  instead of gaining private write access.
- **Transcript completeness:** agents must label archives as
  `full-visible-transcript`, `available-context`, or `summary`. The MCP can store
  what a client sends, but cannot recover turns the client omitted or compacted.
  Never archive hidden prompts, internal reasoning, credentials, or raw tool logs.
- **Large reorganizations:** dry-run `move_notes` or `move_folder` first.
  Applied `move_notes` requires the current etag for every source.
- **Backfill legacy private labels:** after deploying per-note ACL support, run
  the migration locally in dry-run mode. It discovers Markdown notes whose
  frontmatter says `visibility: private` or legacy `scope: private`, reads each
  current etag, and plans `set_visibility(..., private)` without moving or
  rewriting anything:

  ```sh
  ./bin/brain-keychain-helper run-proxy \
    node scripts/backfill-private-note-visibility.mjs
  ```

  Review every path, then repeat with `--apply`. The operation is idempotent and
  uses the MCP API rather than editing the privacy manifest unsafely. Use
  `--prefix 2-areas/public-worship --prefix 2-areas/fount` to limit a pass.
- **Rotate a token:** `openssl rand -hex 32`, `wrangler secret put TEAM_TOKEN`,
  update the affected tools. Do this whenever a shared tool's config may have
  leaked, or on offboarding a tool.
- **Rollback a note:** previous versions live at `.history/<path>.<timestamp>.md`
  (personal access or dashboard only).
- **Backup:** the Obsidian vault on each device is already a full local copy.
  For a paper trail, `git init` inside the local vault and commit occasionally —
  or add a nightly export later.
