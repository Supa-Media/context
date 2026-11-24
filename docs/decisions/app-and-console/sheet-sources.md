# Sheet sources: a key that adds rows to one sheet

## Anything that can send an HTTP request can add rows to a sheet

*Decided by the owner, 2026-11-24* ("shouldnt we have a generic way for
people to setup a webhook or data end point? a daily routine llm routines
seems inefficient"; then "yes" to the shape below).

**Why.** An area's numbers live in its `metrics.csv`. Filling them by a daily
model routine costs a model run to copy a number a script already has. A CI
job, a cron or a monitoring hook should post its reading and the sheet should
gain a row, with no model in between.

**What it is.**

- **A source is a key for one sheet.** An editor opens a sheet, chooses
  **Data sources**, names the source ("GitHub speed budgets") and makes a key.
  The key (`ctxs_` and 32 random bytes) is shown once, with the one call that
  uses it, and never again. Only its SHA-256 is stored
  (`apps/convex/functions/sheetSources.ts`, table `sheetSources`).
- **One call.** `POST https://context.lc/api/sheets/rows` with
  `Authorization: Bearer ctxs_…` and `{"rows": [{"column": "value"}]}` (or
  one row object on its own). A `date` column left out fills with today, in
  UTC. Values are text, numbers or true/false; anything nested is refused
  (`apps/convex/functions/lib/sheetSourceRoute.ts`). The router hands
  `/api/sheets/` to Convex (`infra/router/src/route.ts`).
- **Append only, to that sheet only.** The path is the key's own row, never
  the request's. A key cannot read the sheet or any other note, update or
  delete a row, or name another path. The rows go through the same sheet
  module the app and agents use (`apps/mcp/src/sheets/csv.js`), so a row the
  grid would refuse is refused, whole, and nothing is written
  (`apps/convex/functions/lib/fileOps/sheetAppend.ts`).
- **Its maker's live authority.** Every use writes at the clearance its maker
  has now, at editor or above. A key stops when its maker leaves, is demoted
  to member, or can no longer see the sheet, with nobody remembering to revoke
  it. Its maker or an owner can revoke it at once; an editor sees only the
  keys they made, an owner sees every one. A key names a path, so if the
  sheet is renamed or moved it stops, and a new key is made for it.
- **One refusal for everything about the key.** No key, a malformed one, an
  unknown one, a revoked one, one whose maker can no longer write, or one
  whose sheet is gone: the same 401 bytes, so a caller cannot tell a key taken
  back from one never made. Rows that do not fit (400), a spent allowance
  (429) and an encrypted sheet (409) say so: those are facts about the
  request.
- **A name that cannot be Markdown.** A source's name is written into the
  activity, so it takes letters, numbers, spaces and `- . , ' & +` only.
- **Bounded.** At most 100 rows a call, 64 KB a request, 1,000 rows an hour a
  key (a call that would only partly fit spends nothing), and 20 live keys a
  sheet. Readings, not imports.
- **Audited.** Each write is recorded as its maker "via" the source's name in
  the workspace's activity, with the rows it added.
- **Not from a chat.** Tex and agents add rows with `write rows` as before;
  making a key is a step in the app, so a key is never typed into or shown by
  a model (`packages/tex/gateway/agent/capabilities.js`, Sheets).

**Why not a webhook URL with the secret in it.** Credentials never live in
URLs (non-negotiable 1): a URL ends up in logs, referrers and screenshots. A
header is what every HTTP client, CI system and `curl` can already send.

**What a "simplification" would cost.** Taking the path from the request
turns a key for one sheet into a key for the workspace. Writing at a stored
role instead of the maker's live one keeps a departed member's key working.
Distinct refusals for revoked and unknown keys let a caller probe which keys
ever existed. `apps/convex/__tests__/sheetSources.test.ts` fails on each, and
`apps/convex/__tests__/structure/httpRoutes.test.ts` lists the route's
factory (`sheetSourceRoute`) as the only door of its kind.
