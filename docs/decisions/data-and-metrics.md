# Data and metrics: sources connected once per workspace, metrics as formulas

*Decided by the owner, 2026-11-24.* After the first design (each area
connecting its own source) the owner wrote: "people will continually add the
same sources, why not have a place where we can define data sources for the
entire workspace, and then people / AI can create custom metrics ... combining
that and maybe ai credits spent from cloudflare, revenue from stripe all
together in one metric?", reviewed the artboards
(`data-sources-artboards/` in the project's files) and said "go ahead and
implement this".

## The model

- **A Data folder**, a built-in folder made when first used, like Website and
  Tex. It is found by its job, never by its name, so it can be renamed or
  nested. Its folder page is the Data page.
- **A source is a subfolder** of the Data folder (`github/`, `cloudflare/`,
  `stripe/`, `context/`, or one named by the person for a push source). Its
  `about.md` holds its settings, never a credential. Its **datasets** are
  ordinary CSV sheets beside it ([sheets](./sheets.md)): read, shared and
  exported like any sheet.
- **A metric is a note** in the Data folder's own `metrics/` folder: front
  matter `metric` (its name), `formula`, `every` (`day`, `week`, `month` or
  `N days`) and `format`. Its body is a plain reading of the formula and never
  carries a value.
- **An area picks one metric** by name in its `about.md` and sets its own
  target, so two areas can watch one metric against different targets.

Why files: everything a source syncs and every metric someone defines leaves
with Download as folders, and every agent reads it with `fetch`
(non-negotiable 1). A database beside the notes would hide both.

## A formula is a small language, worked out when it is read

- **Grammar.** `sum`, `count`, `average`, `median`, `p95`, `min`, `max` over a
  column `source/dataset.column`, with per-row `+ − × ÷` inside
  (`deployed - opened`), an optional `where col = value` joined by `and`, and
  `+ − × ÷` between aggregates. A window is the metric's `every`: an hour or a
  block of `N hours` (2, 3, 4, 6, 8 or 12, aligned to UTC midnight; the
  owner, 2026-11-24), a calendar day, ISO week or month to date in UTC, or a
  rolling `N days`. A chart names an hour block by its start in the reader's
  own time. A date minus a
  date is minutes. There are no loops, no user functions and nothing that
  reaches out; the parser is hand-written and refuses `__proto__`,
  `constructor` and `prototype`, and a formula is at most 2 KB, 8 aggregates
  and 32 nodes (`apps/mcp/src/data/formula/`).
- **Worked out at the reader's own access.** The app (Data page, Areas,
  builder preview) and the gateway evaluate a formula over the sheets the
  reader can see. An input they cannot see is handled exactly as a missing
  one, and drawn "Hidden". So a team metric over a private sheet shows its
  number only to people who can see that sheet, and no computed value is ever
  written where a wider audience reads it.
- **No stored history for a metric over a table of events** (the owner,
  2026-11-24, replacing a shared `metrics/readings.csv`): "I would keep a
  table for PRs merged each hour, and then do the calculation on the fly".
  The source sheets are that table (one row per pull request, charge or
  run), so any hour, day, week or month is worked out from them when it is
  looked at. Storing per-period numbers and adding them up would be wrong for
  medians, p95s and ratios. Sources sync every hour.
- **Only a "right now" number is snapped**: one with no table of events
  behind it (open incidents, a value fetched from a URL) can't be worked out
  again later, so the sync keeps it hourly in that metric's own sheet beside
  its note, as visible as its inputs. (Being built; see the section below.)

**What a simplification would cost.** Computing on a schedule at an owner's
clearance and writing the value into a team sheet turns any editor's formula
into a reader of private sheets. Letting the model run code or call out
makes a metric a prompt-injection target. Tests:
`apps/mcp/test/dataFormula.test.mjs` (a hidden input and a missing one give
identical answers; `__proto__` refused).

## Sources sync without a model, in their own object

- **Built in:** Context (counts of notes by folder and status, and time to
  answered, counting only notes visible at the dataset's own folder's
  visibility). **Connected once by an owner:** GitHub (a read-only GitHub
  App), Cloudflare and Stripe (read-only keys). **Made by an editor:** push
  sources, whose key adds rows to one dataset ([sheet-sources](./app-and-console/sheet-sources.md);
  the endpoint stays in the control plane for now), and fetch from a URL.
- **Sync runs in a Durable Object of its own** (`data:<workspaceId>`), never in
  the workspace object's alarm, so a slow or failing API never delays a note
  save, the mirror flush or a Tex routine. Each run re-asks at run time
  whether the source, its owner and its connection are still live.
- **Bounded.** A dataset keeps a rolling 400 days. A run that would take a
  sheet past 50,000 rows or 5 MB writes nothing and names the sheet. A sheet a
  source keeps is read-only in the app, which says so.
- **Synced cells are quotations.** Pull request titles and fetched values are
  marked untrusted wherever an agent reads them, as a sheet's cells already
  are.

## Who does what

- **Owners** connect and disconnect sources. **Editors** make metrics and push
  keys. **Members** read.
- **A connection a source uses is the workspace's, read-only and reached only
  by the sync object.** This narrows the 2026-10-21 rule
  ([connectors](./connectors.md#a-connection-is-one-persons-for-now)) for one
  purpose: Tex, a chat and an MCP tool still never reach a workspace-wide
  connection, and a sync connection can only read.
- **A source's key is bound by the owner's Connect, never by `about.md`.**
  Editing `about.md` cannot point a source at another vault entry, host or
  path; a vault entry kept for syncing is opened only by the sync object, and
  never by an AI client or `send api`.

## What stage B draws, and what it leaves out

*Stage B, 2026-11-25: the Data page (board 01), a source's page (07, 09, 10),
the metrics page (11) and a metric note (12),
`apps/mobile/features/console/files/data/`.*

- **Every number is worked out in the app as it is read**, through the
  reader's own `readBody`: a sheet they cannot read never arrives, so it is
  missing, and a metric with a missing input is drawn "Hidden" (a period
  with none, "—"). The app keeps no computed value anywhere but memory.
  Sheets are cached per reader and folder generation, like an area's
  readings. Test: `apps/mobile/__tests__/dataSources.test.ts` (a hidden
  input and a missing one give identical results, and the result never names
  the sheet).
- **Status lines say only what is known.** Stage B had no sync object, so a
  source other than a url one (whose line is its sync's, below) says "Last row 2h ago" from its newest dated row, or
  "Not synced yet" / "No rows yet", never "Synced 5 min ago"; a period is
  "worked out as you read", not "every hour". `readings.csv` is shown when it
  exists and not yet written.
- **Connect a source offered "Send from your code" only** (Fetch from a URL
  joined it with the sync object, below). It writes the
  source's `about.md` (`source: push`) and its first sheet as the person's
  own notes, then opens the existing key dialog. GitHub, Cloudflare and
  Stripe need the owner's connection and wait for their stage. A key is
  listed by its name, when it was made and when last used, and never shown
  again; the control plane does not keep who made one, so that name is not
  drawn.
- **The Context source is counted on read, never written.** `notes-by-status`
  counts today's notes by `status:` in the folders its `about.md` names, so it
  has today's rows only, not a history; `time-to-answered` needs a note's
  `asked:` and `answered:` front matter, and notes without both are left out.
  It counts only the notes the reader can see, so two readers may see two
  counts.
- **Where the pages part from their boards, on purpose.** No "Count a
  folder" button on the Context source (10): which folders it counts is
  edited in its `about.md`, and a button would only open that. A metric
  note's readings sit over its body, not under it (12): the body is the
  editor, which scrolls itself. A value has no unit after it ("1,436", not
  "1,436 ms"): the shared formats have none. A file or key row says when, not
  who ("Edited 3d ago", "Made Nov 3"): no editor's name is kept for it. The
  page head's tile is the Data job's icon, as every built-in folder's is.
- **New metric** writes a note in `metrics/` with a starting formula over a
  sheet the workspace has, and opens it. A metric note opens with its
  properties and readings over the body, which stays the person's text.

## What a sync run may write, and how a URL is fetched

*2026-11-25: `apps/mcp/src/data/sync/keep.js` and
`apps/mcp/src/data/fetch/url.js`, the pure core the sync object will run.*

- **A dataset row is matched by its key column**, so a run that sees a pull
  request or a charge again changes its row in place. Rows older than the
  rolling 400 days go; a row whose date cannot be read stays, because the
  sync never guesses a row away. A sheet whose synced columns were changed by
  hand is left alone and named.
- **Past 50,000 rows or 5 MB, a run writes nothing** and names the sheet,
  rather than cutting it short.
- **Fetch from a URL is held to the site reader's lock and more**: https on a
  public name only (no port, login or IP literal); the name is looked up over
  DNS over HTTPS first and refused if any answer is private, loopback,
  link-local, shared, documentation, multicast or a wrapped v4 address; no
  redirect is followed; nothing but an agent name and `accept` is sent; at
  most 5 MB and 10 seconds. It reads CSV, or JSON that is a list of flat
  objects; `__proto__`, `constructor` and `prototype` are refused as column
  names, and a row is an object with no prototype.

**What a simplification would cost.** Following a redirect, or skipping the
lookup, lets an editor's address reach whatever the gateway's network can.
Cutting a sheet at its bound loses rows silently. Tests:
`apps/mcp/test/dataSync.test.mjs`.

## What stage C draws

*Stage C, 2026-11-25: an area picks a metric (boards 05, 06 and 13b) and a
synced sheet says it is kept up to date (08),
`apps/mobile/features/console/files/folderPage/areas/` and
`apps/mobile/features/console/files/data/syncedSheet.ts`.*

- **Where an area's metric is written.** The design review sketches
  `metric: Revenue per AI dollar` and `target: over 5`. The app keeps the
  seat's own line instead, `metrics: [Revenue per AI dollar · target over
  $5]`, its first item the area's one metric, because it is what the Areas
  page, the seat pop-up and every agent already read and write (one metric
  per area, [areas-as-seats](./app-and-console/areas-as-seats.md)). A
  `metric:` line, with a `target:` beside it, is read too and wins over
  `metrics:`; saving the seat writes the `metrics:` line and removes those
  two, so an area says its metric once (`seat.ts`, `metricsOf`). The picker
  writes `over <value>` or `under <value>`; the list draws them as `>` and
  `<`, and `at least` / `at most` written by hand as `≥` / `≤`.
- **An area's reading is the workspace metric of its name**, lower-cased,
  worked out as it is read by stage B's engine over the sheets the reader
  can read: Hidden when one is missing or held back, never naming it. A name
  that no metric note the reader can read has, a renamed metric included,
  reads the area's own `metrics.csv` exactly as before stage C, so an area
  set up that way keeps working; nothing reads or writes a shared readings
  sheet for an area. Two metric notes of one name: the first in the metrics
  folder's order is read, and the picker shows the second as not pickable
  until it is renamed. Test: `apps/mobile/__tests__/areaMetric.test.ts`.
- **The list's label line says what is known.** "Revenue per AI dollar ·
  Stripe + Cloudflare · last row 11h ago": the sources are the formula's,
  named as the Data page names them, and the time is the newest dated row
  the metric reads, in stage B's words, since there is no sync time yet; a
  metric over the Context source alone says no time. In the row's 220 of
  metric column (the owner's widths stand) a long line is cut with "…" and
  is whole in its hover; on a phone it has a line of its own.
- **A synced sheet is read-only.** A CSV directly in a GitHub, Cloudflare or
  Stripe source's folder opens under "Kept up to date by GitHub. Edits here
  are replaced at the next sync." with a link to the source's page (left off
  on a phone, as the board draws it), and the grid cannot be edited. A push
  source's sheet only gains rows and the Context source's are counted when
  read, so neither carries it; a url source's does, kept up to date by its
  sync (below).
- **Where the pages part from their boards, on purpose.** The phone picker
  gives the target's value the room beside Over and Under that the board
  takes from "Under", which it clips, and puts the green-when line under
  them. The picker lists every metric the reader can read, in the metrics
  folder's order, rather than the board's four. "Saved in" names the whole
  path, `areas/finance/about.md`. Save and Cancel are the app's own dialog
  buttons, the faces are the app's owner faces, an area's name is its folder's
  as a title ("Mcp"), and values have no unit, as on the Data page. The empty
  picker's footer says "Connecting makes a data folder…" only to someone who
  can connect one; anyone else is told who can. "Connect a source" from the
  Areas page keeps the Areas page open under the new source's key dialog.

## The sync object, and Fetch from a URL

*2026-11-25: `apps/mcp/src/data/sync/` (`object.js`, `run.js`, `route.js`,
`about.js`) and, in the app, `ConnectSource.tsx`, `useSourceSync.ts` and
`dataSync.ts` under `apps/mobile/features/console/files/data/`.*

- **One object per workspace, `data:<workspaceId>`**, SQLite-backed, placed
  with the `enam` hint like every object of ours (`DATA_SYNC`, migration
  `v12-data-sync`). It keeps only which sources are armed (by the about.md's
  note id), who armed each and when, and the last run's time and outcome; it
  keeps no note text, no rows and no credential. The first workspace to call
  it pins it, and it refuses any other. One alarm serves every source: set
  only when none is set, re-set after a run only while a source is still
  running, deleted when none is. A self-hosted gateway without the binding
  answers the route 501 and its url sources say "Not synced yet".
- **Arming is an app step by an owner or editor.** Connect a source → Fetch
  from a URL writes the source's `about.md` (`source: url`, `url:`,
  `dataset:`, and optionally `key:` and `date:`) and the dataset's empty sheet
  as the person's own notes, then calls `POST /@<slug>/files/data-sync`
  (`files` is a reserved first segment, so the address is never read as a
  workspace named `data`) with the console grant. The route takes only the
  console client and a write grant, the workspace named in the body must be
  the session's, the role must be owner or editor, the about.md is read at
  the caller's own clearance (one held back answers as missing), and it must
  sit directly in a source folder of the folder doing the Data job and say
  `source: url` with an address the fetch lock allows. Sync now on the
  source's page arms it again, which runs it at once. Tex can write the
  about.md; arming waits for a person in the app (a `cant` in
  `capabilities.js`).
- **Every run re-checks everything, by note id.** The armer must still be an
  owner or editor of the workspace; the about.md must still exist (deleted, the
  source stops and is forgotten), still sit in a source folder of the Data
  folder (renamed or moved within it, it is followed; moved out, it stops),
  still say `source: url`, and its address is re-read and re-checked by the
  fetch lock each run, so one edited to a private address after arming is
  refused then. The sheet is always `<source folder>/<dataset>.csv`, so two
  sources never write one dataset.
- **A run opens the workspace's storage on the armer's live membership, with
  no token.** It asks the workspace object for the sealed binding as the
  person who armed it, at `team` scope with no groups, as a request of theirs
  would; there is no request, so there is no grant to check. This extends the
  second proof given up in
  [credential-basics](./storage-and-credentials/credential-basics.md) to a
  scheduled run: the live membership checked by the object is the whole
  proof. Removing the person, or their edit role, stops the source at its next
  run. *For the owner to confirm.*
- **A write is a non-person writer's, audited.** The sheet is written with a
  conditional put on the etag it read, as client `context_data_sync`
  ("Data sync") acting for the armer, and the audit records `data_sync` with
  both. A run that fails anywhere (refused address, unreadable answer, no key,
  past the bounds, a sheet changed by hand, a lost race) writes nothing, and
  its sentence is what the page shows.
- **Rows from an answer.** The date column is `date:`, else a column named
  `date`, else a `fetched` column holding the run's hour, so an address that
  answers one value makes one row an hour (a second run in the hour replaces
  it). The key is `key:`, else the date when the answer is one row; an
  unkeyed list is refused and says to add `key:`. New columns are appended.
- **The status line is the sync's.** A url source says "Synced 5 min ago",
  the refusal in its own words, "Stopped …" or "Not synced yet", never "Last
  row …" from a row's date; its sheet opens read-only, kept up to date by its
  source. A source is run at most once a minute however often it is armed,
  and a workspace syncs at most 25 addresses. A url source sends nothing that
  signs in, so this stage keeps no vault key for one.

**What a simplification would cost.** Keeping the address read at arming
lets an edited about.md reach a private network; re-setting the alarm
unconditionally keeps a deleted source's object waking forever; setting a new
alarm per arm stacks them; letting any member arm lets a reader make the
gateway fetch on their behalf; an unpinned object lets one workspace's id
drive another's runs. Tests: `apps/mcp/test/dataSyncObject.test.mjs` (arm
auth, tenant isolation, the refused and over-cap runs, a deleted source
stopping the alarm, the recorded run, repeated arms, rename and move, a
removed member) and `apps/mobile/__tests__/dataSyncSource.test.ts` (the form,
the status line, the read-only sheet).
