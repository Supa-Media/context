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
  exported like any sheet, plus any sheet kept elsewhere that its `about.md`
  links (below, "A source's sheet can live anywhere").
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

- **Grammar.** `sum`, `count`, `average`, `median`, `p90`, `p95`, `min`, `max` over a
  column `source/dataset.column`, and `count(distinct …)`, which counts each
  filled value once (people active, not their rows; added 2026-11-25 for the
  Context usage source), with per-row `+ − × ÷` inside
  (`deployed - opened`), an optional `where col = value` joined by `and`, and
  `+ − × ÷` between aggregates. In `+` and `−`, a side whose period has no
  rows adds nothing when the other side has rows (bills this month with no AI
  spend yet is the bills); both empty is no data, `×` and `÷` keep no data,
  and a sheet the reader can't see is still an error, never a 0. A window is the metric's `every`: an hour or a
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
  its note, as visible as its inputs (see "Right-now metrics are kept
  hourly" below).
- **No data is blank, never 0** (Dev2, 2026-11-25: "these metrics look
  fake"). An aggregate is no data when it picks rows by a column nobody has
  filled in yet (a sign-up's channel before it is recorded), when its sheet
  has no rows at all, and for a period that ends before the sheet's first
  dated row, so a trend starts where the records do. A period after the
  first row with nothing in it is a real 0. Test:
  `apps/mcp/test/dataFormulaNoData.test.mjs`.

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
  Editing `about.md` cannot point a source at another key, host, account or
  path; a key kept for syncing is opened only by the sync object, and never by
  an AI client or `send api`.

## Apps connect with read-only keys: Cloudflare and Stripe

*Built 2026-11-25 (stage E, part 2), under the owner's "go ahead and
implement this" of the data sources boards.*

- **The key is kept sealed in the workspace's sync object, not in the
  vault.** The plan said "vault entries that only the sync object opens". A
  vault entry is a person's, shared by levels, and reached by the vault's
  pages, its proxy and `send api`; keeping a sync key there would have meant
  teaching every one of those doors to refuse it. Kept in the sync object
  (`data:<workspaceId>`), it has one reader by construction. It is sealed with
  a key derived from the gateway secret under its own label, with
  `data:<workspaceId>:<app>` as additional data, so a key copied under another
  app, or into another workspace's object, does not open
  (`apps/mcp/src/data/connect/seal.js`). Rotating the gateway secret stops each
  app source with "connect it again". No note, bucket, log or answer holds it.
- **Owners only, from the Context app only.** `POST /files/data-sync` ops
  `connect` (the source's `about.md` and the key) and `disconnect` (the app).
  An editor, a member, an AI client and Tex get 403 before any object hears.
  The app writes the source's `about.md` (`source: cloudflare`) and its empty
  sheet, then sends the key once.
- **Checked with the app before it is kept.** Cloudflare's token must be
  active and reach the account it reads: the one account it reaches, or the
  one the owner names; the account is bound at connect, beside the key.
- **Each run asks again**: the connecting owner is still an owner, the
  `about.md` still says the same app, and the key still opens and is still
  taken. An `about.md` edited to name anything else stops the source, and the
  key goes nowhere (`runApp.js`).
- **What is kept.** Cloudflare's `ai-spend.csv`: AI Gateway's requests,
  tokens and cost in US dollars by day, gateway, provider and model, the last
  30 days each run (its analytics answer about a month per query), keyed so a
  day's row updates in place.
- **Stripe, through one narrow guard exception.** `scripts/check-exit-is-ungated.mjs`
  keeps the word `stripe` off every file under `apps/mcp/src`, because there
  it would mean billing state on the exit path. Reading a customer's own
  Stripe account is their data coming in, so the owner allowed that one word
  in `apps/mcp/src/data/connect/` only, and nowhere else; every other gate
  term still fails there (decided by the owner, 2026-11-25: "Allow it in data
  connectors only"; the guard's self-test proves both sides). Stripe takes a
  restricted `rk_` key only, and a secret `sk_` key is refused before Stripe is
  asked. Its `revenue.csv` keeps the balance transactions that make or take
  back revenue (charges, refunds, disputes and their reversals), in the
  currency's main unit, with `usd` filled when the currency is US dollars,
  and no description or customer, since a description can name one. A run
  reads from three days before its newest row to now, then carries the
  history back toward 400 days, each window capped at half of 50 pages.

## GitHub: an App the owner installs, no token kept

*Built 2026-11-25 (stage F), once the owner made the read-only GitHub App
("Context Data") and set its five secrets. GitHub forbids secret names that
start with `GITHUB_`, so they are `GH_DATA_APP_ID`, `GH_DATA_APP_SLUG`,
`GH_DATA_CLIENT_ID`, `GH_DATA_CLIENT_SECRET` and `GH_DATA_PRIVATE_KEY`, set in
GitHub by the owner, never synced from the vault, and pushed to the production
gateway by `deploy-mcp.yml`. Without all five, connecting GitHub answers 501.*

- **Installed, not pasted.** The owner's Connect GitHub asks the gateway for
  GitHub's install page with a `state` signed (HMAC under its own label from
  the gateway secret) for this workspace, this owner and this source, for 30
  minutes. GitHub sends the owner's window back to
  `https://context.lc/data/github/callback`, which hands the code, the
  installation and the state to the console tab that opened it on a
  same-origin `BroadcastChannel`, and stores nothing. The console tab, signed
  in as the owner, finishes it: the gateway refuses a state that isn't that
  owner's own for that workspace, trades the code for the owner's GitHub
  token, keeps the installation only if GitHub lists it among the ones that
  person can reach, and then revokes that token. The exchange sends
  `redirect_uri` as `<APP_ORIGIN>/data/github/callback` (left out when the
  deployment names no https origin, so GitHub defaults to the first Callback
  URL), and a refused exchange says GitHub's own error code (and its
  description, when plain and free of anything sent) so the next failure is
  diagnosable; never a secret, the code or the token endpoint's body. The
  callback's `?code=` is GitHub's, so the app's sign-in provider is told not
  to redeem it (`shouldHandleAuthCode` skips `/data/github/`): redeemed, it
  signed the owner out on the way back (2026-11-25). An installation id from
  somebody else's link binds nothing. Pasting a key for GitHub is refused.
- **What is kept**, sealed in the sync object like an app key: the
  installation id and the repositories picked (none picked reads every one the
  installation was given, at most 10). Never a token: each run mints an
  installation token from the App's key, narrowed to read-only Metadata, Pull
  requests, Deployments and Actions whatever the App is later given. An
  uninstalled App refuses the mint and the source stops.
- **Three sheets**: `pull-requests.csv` (kept 400 days; recent ones by
  update, history carried back toward 90 days a slice a run through search),
  `deploys.csv` (production deployments only, kept 90 days) and
  `workflow-runs.csv` (finished runs on the default branch plus every run of
  the production deploy workflow (`deploy-production.yml`) on any branch,
  since Promote to Production dispatches it on a `prod-deploy/<sha>` branch;
  each read keeps its own catch-up window; kept 30 days, because a busy
  repository runs thousands a week). `deployed` is when the
  first production release that started at or after the merge finished: a
  successful run of the deploy workflow, or a deployment still marked
  success, filled in by a later run when the deploy comes after. A
  deployment alone is not enough: GitHub marks every older production
  deployment `inactive`, stamped when it was superseded, so matching only
  `success` gave every pull request the one live deployment and open to live
  read days (2026-11-25). A time already kept is checked again once the
  releases kept reach back to its merge. No body,
  review, comment, commit message or file is read.
- **Connecting answers at once; the first run happens behind it**
  (2026-11-25, after production showed the first run taking about 95
  seconds while the app gave up on every call after 30). Finishing the
  install, and saving a repository pick, seal and keep what changed, arm the
  source and answer straight away: armed, with no last run. The run itself is
  queued on the sync object's alarm, set to fire now, and the alarm goes back
  to its hourly time after it. An alarm rather than work left running after
  the answer, because an alarm is kept and retried by the runtime, and it
  keeps the object to one alarm. While a run is going, listing the
  repositories and asking a source's status never wait for it. The app asks
  the status again a few times, on a fixed backoff that stops, while a call
  fails or a source is armed with no run yet, so "Not synced yet" clears by
  itself; the repository picker asks GitHub once per opening and again only
  on Try again; and the form says "Waiting for GitHub…" only while GitHub's
  window is open, then "Connecting…". A pasted-key app (Stripe, Cloudflare)
  still runs at Connect, since it is quick and its first run is the check
  the person waits for.
- **Web and desktop only** for the install itself, since it needs a window
  and a same-origin channel; the phone shows the source and its sheets.

**What a simplification would cost.** A key in `about.md`, the vault or a log
is readable by anyone who reads those; reading the app from `about.md`'s
`source:` alone would let an editor send one app's key to another. Tests:
`apps/mcp/test/dataSyncApps.test.mjs`, `apps/mcp/test/dataSyncStripe.test.mjs`,
`apps/mcp/test/dataSyncGithub.test.mjs`, `apps/mobile/__tests__/dataSyncGithub.test.ts`,
`apps/mobile/__tests__/dataSyncApps.test.ts`, and `--self-test` of the guard.

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
  hand is left alone and named. A column the source writes takes the
  source's type on every run (a sheet made by hand before the first run has
  every column text, and a date read as text places no row in time); a
  column the person added keeps its own.
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
- **The list's label line is the name and its time range** (the owner,
  2026-11-25, reversing the sources-and-age line: it repeated "Context usage"
  on most rows and never said what period a number covers). "Active humans
  `7d`": the tag comes from the metric note's own `every` (`7 days` → 7d,
  `day` → today, `week` → this week, `month` → MTD, `12 hours` → 12h), "now"
  for a right-now metric, and none for a period the engine cannot read or a
  `metrics.csv` line, which names none. The sources and the newest row's age
  stay off the row, in its hover tip (set on the element, since React Native
  Web drops a `title` prop) and on the area's panel and the metric's page;
  a phone's block has no sources line. Test:
  `apps/mobile/__tests__/areaMetric.test.ts` and `areaMetricPicker.test.ts`.
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
  running, deleted when none is. A run that must happen soon (GitHub's first,
  or after a repository pick) is listed as `soon` and moves the alarm to now,
  keeping the hourly time it displaced; that early alarm runs only the
  sources waiting for it, then puts the hourly time back. Runs never overlap
  (one run at a time, apart from the lock that guards what is stored), and
  the alarm re-reads the sources before keeping each result, so a connect,
  arm or disconnect that lands during a long run is never overwritten by it. A self-hosted gateway without the binding
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
  run. Decided by the owner, 2026-11-24.
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

## Right-now metrics are kept hourly

*2026-11-25, `apps/mcp/src/data/sync/snap.js`, `apps/mcp/src/data/formula/evaluate.js`
and `apps/mobile/features/console/files/data/useMetricKeep.ts`.*

- **What makes a metric "right now".** Every sheet its formula reads has no
  date column (and no `on` names one): open incidents, seats on a plan. Its
  value is worked out over the rows as they stand. A formula over one sheet
  with dates and one without is refused in words, since its periods would mean
  two things. A sheet the reader can't see is still said as "can't read",
  before anything about its dates, so hidden and missing still read alike.
- **Where its history lives.** One sheet per metric, beside its note:
  `<data>/metrics/<slug>.csv`, columns `hour` (date) and `value` (number),
  one row an hour, keyed by the hour (a second run in one hour replaces its
  row), 400 days kept. Each past period on its page is the last reading kept
  in it; the current one is its value now, worked out as the reader reads.
- **Kept by the sync object, armed by an editor.** "Keep every hour" on the
  metric's page makes the sheet when there is none and arms the metric in the
  workspace's sync object (`kind: "metric"`, beside its url sources, 25 at
  most). Each run asks again whether its person may still edit, whether the
  note is still directly in the Data folder's `metrics/`, and whether its
  formula still reads only undated sheets (if not, it stops and says why).
- **Never written where more people read it than can read its inputs.** The
  value is worked out as the person who armed it reads the sheets, so it is
  kept only when, by the workspace's own rules (member and guest), the kept
  sheet lets in nobody an input does not: the kept sheet owners-only
  (`private`), or the input carrying the very same setting (`team` under
  `team`, one group under that group). An input held for a group or named
  people under a team kept sheet, or anything under a sealed folder, keeps
  nothing, and the page says which sheet and to give them the same setting. A
  link minted on the metrics folder publishes these values as it publishes the
  folder's other `team` notes: they are made only of `team` sheets.
- **Tex.** A right-now metric is a metric note like any other, so Tex's line
  is unchanged; keeping one hourly is the app's step, as Sync now is.

**What a simplification would cost.** Working the value out at the armer's
own clearance and writing it wherever the note is would let an editor in a
group publish a group sheet's numbers to the whole team; arming without the
role check each run keeps a removed editor's standing alive; reading a dated
formula's value hourly would store per-period numbers the decision above
rules out. Tests: `apps/mcp/test/dataSyncSnap.test.mjs` (the narrower input
kept nothing, owners-only kept sheet, a removed editor stops, a dated metric
stops, hourly rows and same-hour replace, refused bodies),
`apps/mcp/test/dataFormula.test.mjs` (right-now, mixed, hidden-reads-as-
missing, kept series) and `apps/mobile/__tests__/metricKeep.test.ts`.

## CI sends its own numbers

*Asked by the owner, 2026-11-25, with the area metrics plan: "wire push rows from
the Tex test set, the search bench and CI on merge". `scripts/metric-rows.mjs`.*

- **One sheet, one key.** The Tex test set, the search test set and a merge
  that changes the capability list or the replay cases each add rows to one
  workspace sheet through a sheet key ([sheet-sources](./app-and-console/sheet-sources.md)),
  `METRICS_PUSH_KEY`. A person makes the key in the app on that sheet and
  pastes it into the repository's secrets; it can only add rows there. With
  no key the step says so and sends nothing.
- **The columns.** `date, check, part, value, of, main, pr, sha`. `test-set`
  sends `all`, `kind:one`, `kind:group` and one `node:<id>` row a run (right
  on the change, of the total, right on main); `search` sends `first` and
  `top5`; `capabilities` sends `covered` (of all capabilities) and `cant`; a Lab search
  run on main's code (Evals, `lab-eval-run.yml`) sends `bench:<id>` `first`
  and `top5`, so the Search area can read enterprise-rag-notes and the other
  standing benchmarks (owner, 2026-11-25: "we havent wired in our enterprise
  rag run results?").
- **Counts only, never part of a gate.** The rows carry the numbers the run
  already prints to its log, never a case's words (the Test Set stays sealed:
  [test-set-service](./testing/test-set-service.md)). The step is
  `continue-on-error`, so a refused key never fails a pull request.
- **By kind.** The eval service's verdict now also counts by conversation
  kind (`byKind`, `infra/tex-eval/src/rules.ts`), so the Group chats area can
  read group cases apart. The gate still reads only `byNode`.
- **Coverage, as counted.** A capability is covered when a replay case reaches
  one of its actions (`send.email`, `manage action area`,
  `ACTIONS.manage.area`, `action: "area"`) or names it in
  `capabilities: [...]`. A capability with no actions of its own is covered
  only by name.

**What a simplification would cost.** Sending a case's text instead of its
counts would put the sealed Test Set in a sheet every member reads; making the
step required would let a missing key block every Tex change. Tests:
`node scripts/metric-rows.mjs --self-test` (counts-only rows, no key sends
nothing, key only in the header, batches of 100) and
`infra/tex-eval/src/testSet.test.ts` (by kind, gate unchanged).

## The Context usage source

*Decided by the owner, 2026-11-25: the area metrics plan (Active humans,
Returning users, Weekly texters, writers and callers, New actives, Day-1
active, First text p95, Texts answered, Orient p50, Fetch p50, Request
errors, Search p95, Call success), "we should get started on these metrics
asap", and, on where the rows go, "Only @supa, named in gateway config".*

- **Context-wide, into one workspace.** These metrics count every person
  using Context, so the rows come from all of Context and land in the one
  workspace the gateway's config names (`USAGE_WORKSPACE`, a slug, in
  `apps/mcp/wrangler.toml`; unset means none). Arming it (Sync now on its
  page) is refused in any other workspace, and by anyone but an owner there.
  It is a source folder like any other (`data/usage/`, `source: usage`).
- **Owners only, checked every run.** Its four sheets must be `private`, by
  both the member and the guest rendering, and under no sealed folder. A sheet
  or folder loosened later stops the source before anything is read, so a
  wider setting never publishes a row.
- **Nobody can tell who a row is.** A person is 16 hex of HMAC-SHA-256 over
  their account id, under a key derived from the root the gateway's
  `SEARCH_QUALITY_KEY` object keeps (`apps/mcp/src/usage/person.js`), never
  `GATEWAY_SECRET`, which the control plane holds. The control plane keeps the
  MAC, not the account (`usagePeopleDaily`, one row per person per day, 90
  days); the account ids it hands the gateway for texts and sign-ups are
  MAC'd before anything is written. Deleting that object rotates every id.
- **What each sheet holds.** `activity.csv` (one row per person-day: texted,
  wrote, called, `active` = texted or wrote, `returning` = active that day
  and on another day in the 7 before, so a day with only an AI client's call
  is neither and Returning users never passes 100%; 90 days), `sign-ups.csv` (one row per person: day,
  channel, `day1_active` = active that day or the next; 400 days),
  `tex-replies.csv` (one row per answered text with the seconds to its first
  bubble, and one per text a turn failed to answer; 30 days) and `calls.csv`
  (one row per sampled MCP tool call: tool, ms, ok, the client's product name
  and Analytics Engine's sample weight; **14 days, not the plan's 30**: about
  2,600 calls on a busy day would take 30 days past a sheet's 50,000 rows).
- **Where each fact comes from, and nothing new where something exists.**
  Texted: a person's own 1:1 texts, already `agentTurnMarks` in their personal
  workspace (a group's turn runs on its sponsor's grant, so it can't say who
  texted). Wrote: the app's own saves (`update_note`, `create_note` by the
  console), marked behind the response. Called: any tool call by a client that
  is not the app or Tex. Calls and replies: the gateway's Analytics Engine
  points, read by the control plane with the staff stats' token. `ok` is the
  request answering without a server failure; a tool that answers with an
  error still reads ok.
- **What the first week could and could not fill.** Texted, Tex replies and
  calls go back as far as those records do (30 days of turns). Wrote and
  called start the day this shipped: rebuilding them would mean reading every
  customer's editing history, which the usage source never does.

### The app's own vitals in the same source

*Decided 2026-11-25, on the owner's pick of the recommended option: the app
reports Start time, Load time and Clean sessions itself rather than reading
them out of Sentry.*

- **One row per session per kind, in `app.csv`** beside the other sheets, so
  it inherits every check above. Columns: `id` (`<session>:<kind>`), `at`,
  `platform` (web, desktop, ios, android), `kind`, `ms`, `session`; 30 days.
- **What a session is.** One launch of the app, named by 16 random hex the app
  makes at launch (`apps/mobile/features/observability/vitals.ts`). It names
  nobody: the control plane's `appVitals` table keeps no account, device,
  screen or error text, and deletes rows after 30 days.
- **The kinds.** `session` (it happened), `start` on a phone or `load` in a
  browser or the desktop shell (milliseconds to the first frame: since the
  page was asked for in a browser, since the app's code began on a phone, so
  a phone's number reads a little short), and `error` (the session reached
  `reportError` at least once). Clean sessions is one minus sessions with an
  error over all sessions.
- **Only with Crash reports on, and only signed in.** Off, the app notes
  nothing; signed out, nothing is sent. The control plane keeps one row per
  session per kind and 40 a person an hour, so a loop cannot fill the sheet.

### Bug reports in the same source

*Decided 2026-11-25, on the owner's "ship user reported bugs going into a
sheet overnight, either through tex or in the app".*

- **One row per report, in `bug-reports.csv`** beside the other sheets,
  so it inherits every check above: the named workspace only, armed by an
  owner, owners only by both renderings, re-checked every run. Columns:
  `reference`, `filed`, `person`, `channel`, `status`.
- **Which reports.** Every report sent through the one intake
  (`lib/feedback/deliver.ts`): the app's bug button (`app`), a text to Tex
  (`tex`), Tex in a group chat (`tex-group`) and another AI's
  `report_problem` (`agent`). A report about content (`functions/reports.ts`)
  is not a bug and never listed. The receipt the intake already keeps for the
  daily budget now carries that one word (`channel`); receipts made before it
  carry none and are not listed (the hand-kept `data/feedback/reports.csv`
  covers those).
- **No words of the report.** A row holds the reference the person was told
  (the Tex bug note's `reference:`, or the app's Sentry event id), the time,
  the person MAC shared with `activity.csv`, and the channel. The report
  itself stays where it was filed: a Tex bug note readable by the pinned
  workspace's members, or Sentry. Who reads the sheet (the usage workspace's
  owners) is not provably within who reads the report, so a summary or a
  path, whose name carries the report's first words, is left out until that
  is checked per row.
- **`status` is the team's.** A new row says `open`; a run never writes over
  it (`mergeSynced`'s `handColumns`), so triage edits in the sheet stay.
- **Backfill.** The sheet's first run reaches back 30 days on its own
  (`bugsSince`), as far as receipts are kept.

**What a simplification would cost.** Keying a row by account id, or by a MAC
under `GATEWAY_SECRET`, lets the control plane or a sheet reader name the
person. Checking visibility only when armed lets a later setting publish the
rows. Letting any owner arm it gives every workspace everyone's activity.
Listing a bug report's text or note path in the sheet would hand it to
owners who may not read the report. Tests: `apps/mcp/test/dataSyncUsage.test.mjs`,
`apps/convex/__tests__/usagePeople.test.ts`.

## A source's sheet can live anywhere

Decided by the owner, 2026-11-25: a hand-kept sheet belongs with the work it
measures (the Filings list in `areas/operations/Filings/`, the weekly scores in
`areas/operations/Scorecard/`), because without it an area is hard to make sense
of. The metric and its source stay in the Data folder; only the sheet moves.

- The source's `about.md` links each such sheet in its front matter,
  `sheets: ["[[areas/operations/Filings/filings.csv]]"]`. The dataset is the
  sheet's file name, so a formula still says `filings/filings.status`. A sheet
  in the source's own folder keeps a name both have
  (`apps/mcp/src/data/sheetLinks.js`, shared by the app and the hourly keep).
- **Nothing is searched for.** The app lists only the folders those links name
  (`foldersOfLinkedSheets`), and the hourly keep reads only the about notes of
  the sources a formula names. An area folder is never scanned for sheets.
- **A link, not a bare path**, because the move engines already follow a link
  in front matter: renaming or moving the area keeps the metric reading.
- The rule that a kept value is never written where more people read it than
  can read its inputs is asked of the sheet where it really is: an area folder
  narrower than the kept sheet keeps nothing and names the sheet.

What a "simplification" would cost: sheets only under `data/` puts an area's
working list in a folder nobody opening the area sees; scanning area folders
for sheets makes every Data page load read the whole areas tree. Tests:
`apps/mcp/test/dataSheetLinks.test.mjs`, the linked-sheet case in
`apps/mcp/test/dataSyncSnap.test.mjs`, `apps/mobile/__tests__/dataLinkedSheets.test.ts`.
