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
  `+ − × ÷` between aggregates. A window is the metric's `every`: a calendar
  day, ISO week or month to date in UTC, or a rolling `N days`. A date minus a
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
- **`readings.csv` keeps closed periods only.** The Data folder's
  `metrics/readings.csv` (`date, metric, value`) gains one row per metric per
  closed period, and only for a metric whose every input is at least as
  visible as the `metrics/` folder.

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
- **Status lines say only what is known.** There is no sync object yet
  (stage E), so a source says "Last row 2h ago" from its newest dated row, or
  "Not synced yet" / "No rows yet", never "Synced 5 min ago"; a period is
  "worked out as you read", not "every hour". `readings.csv` is shown when it
  exists and not yet written.
- **Connect a source offers "Send from your code" only.** It writes the
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
