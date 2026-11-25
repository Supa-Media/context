# Areas are seats: the Areas folder is a List and a Chart of who holds what

## An area is a seat, written in its own about.md

*Decided by the owner, 2026-11-23* (prototype rounds in the project note
`projects/backlog/areas-as-seats.md` of the team's workspace).

**Why.** One person covering too many scopes lets something slip, and agents
fail when one prompt asks them to decide, check and do at once. Making each
area's holder, its modes and its numbers visible, beside the notes, shows
who to ask and what is not covered. No new concept: an area is the seat.

**What it is.**

- **The seat is a few top-level lines in the area's `about.md`**: `owner`,
  `delegate` (the one bot or Tex acting for a person owner there; `helper` is
  its old name, still read: [area-bots](./area-bots.md)), `modes` (Visionary, Manager, Doer: labels, never rules), `metrics`
  (one line each, `Name, target <what good looks like>`) and `approvals`
  (one rule a line). Every line is a plain property a person, Tex or any agent
  edits as text; nothing new is stored anywhere else
  (`apps/mobile/features/console/files/folderPage/areas/seat.ts`).
- **Which folders are areas.** Every folder directly in the Areas folder (by
  job, `inAreasNow`) unless its `about.md` says `area: false`, and any deeper
  folder whose `about.md` has a seat line or `area: true`. Everything else is a
  plain folder, listed under its area. An area with no owner of its own
  follows the nearest area above that names one.
- **The page.** The Areas folder and every area in it offers **List** (the
  default, an outline of areas with their notes, sheets and plain folders) and
  **Chart** (the open area on top, its sub-areas below), remembered per
  viewer like a projects folder's List and Board. A right-click or ⋯ on a row
  or box opens the seat menu; Edit seat opens the pop-up that writes the
  lines; Add a sub-area writes a new folder's `about.md`.
- **Both views draw the approved prototype, not an approximation of it**
  (the owner, 2026-11-23, after the first cut shipped as plain boxes). In
  the Areas folder itself the top is the workspace ("Supa"), not "areas".
  The Chart is an org chart: lines from the top box to one row of area
  columns, sub-areas stacked under their parent; on a phone the same tree
  stands up, with sub-areas folded under their parent. The List nests every
  area under that top row; a chevron shows only where an area has
  sub-areas.
- **A number is shown against its target** (the owner, 2026-11-24: "it's
  hard to know whether we're doing good or bad"). A box shows its first
  metric's latest value, green on target and amber off it, beside its short
  target and over "On target" or "Off target". Times compare
  across units (`readings.ts`), and a missed target turns the title dot amber.
  An empty seat says "No owner" itself, as a dashed box with Assign owner.
  "No manager loop", flagged for modes without Manager, was removed the same
  day: modes are labels, never rules.
- **One metric per area, drawn as a trend; notes hidden behind a count**
  (the owner, 2026-11-24, choosing board "E Trend": "if an area needs
  another metric it should create new sub areas"). Each area shows one
  metric: its label, a sparkline of its readings with the target as a
  dashed line on the same scale, then the latest value (green on target,
  amber off it) and the short target (`< 800 ms`). The seat pop-up offers
  "+ Add metric" only while there is none, and the menu says "Edit metric…"
  once there is one; older `about.md` files with several `metrics:` lines
  keep them, and the first is the one shown. A list row's notes and folders
  stay hidden until its count is pressed, with no cap once open. Both views
  keep the board's layout but the app's own type scale (names and values at
  13, labels at 12, 40-high rows, 232-wide chart columns): drawn at the
  board's 14-16 with 60-high rows, it read "way too big" beside the sidebar
  (the owner, 2026-11-24). Put beside the Projects list, the owner tried both
  measures and kept this one for both pages (2026-11-24: "I'd rather have
  this prototype scale"): a projects List on a pointer takes the Areas
  list's 40-high rows and its 13 semibold names, rather than Areas shrinking
  to the tree's 36 and 16. Both lists keep the page's own column, edge to
  edge with the title and the List · Chart switch, as the prototype draws
  them: an 820 list centred under a 640 title overhung it on both sides and
  read as "spacing still looks off" (the owner, 2026-11-24). Their ⋯ shows
  on hover only. Check a redraw inside the app beside its neighbours, not
  only against the board.

  One press on an area shows it in the console's right panel, as its Area
  tab beside Meetings, opening the panel if it was shut (the owner,
  2026-11-24: "just put it in the left panel like this", of that panel; a
  card inside the page read as "not a side panel"). Where no console hosts
  the page, it is drawn beside the list. One press on an area shows it, and a
  second press at once (or the panel's Open area) opens its page (the owner,
  2026-11-24, after trying the prototype: "one click open up the right panel,
  double click to get into more details"). The top row (the workspace) shows
  there too. Everything in the panel is edited where it is drawn, with no
  pop-up (the owner, 2026-11-24: "why cant I make changes inline? wth is the
  point of a side panel if its just going to link to this ugly pop up"), laid
  out as the prototype: the metric's name and its goal; Owner and, for a
  person owner, Delegate as dropdowns; the modes; the holder's phone and email
  (an agent's access and vault item instead); the approval rules; the
  sub-areas with their values; and the area's notes. Each change goes through
  the seat pop-up's own save. A phone has no panel: a press opens the area.
  `areasPanel.test.ts` fails if a single press opens the area on a page with
  room, or if the owner, delegate, card or rules need the pop-up.

**What a simplification would cost.** Keeping seats in a table of their own
would hide them from every agent that reads notes and from Download as
folders. Enforcing modes would turn labels people try on into rules they fight.

**Tests.** `apps/mobile/__tests__/areasSeat.test.ts`, `areasPage.test.ts`, `areasList.test.ts`.

## How to reach a holder is a card per workspace that everyone in it sees

*Decided by the owner, 2026-11-23*: "per workspace, and everyone with access
to the workspace should see details".

**Why.** When something breaks, the person triaging needs to know who holds
the seat and how to reach them, including when the holder is an agent.

**What it is.**

- **One note per holder** in the Areas folder's `people/` folder
  (`people/dev2.md`, `people/claude-code.md`), whose `about.md` says
  `area: false`, so the cards are never a seat. Every seat a holder takes shows
  the same card, and it is read at the folder's visibility like any note.
- **A person's card**: `phone` and `email`. Who acts for them is each area's
  delegate, not the card (the owner, 2026-11-25); the card's old `delegation`
  and `delegation_how` lines are cleared when it is saved.
- **An agent's card**: `access` (where and how to reach it, e.g. "only through
  other Grokbots, or the Grok UI on this account") and `vault`, the **name** of
  the vault item that holds its login. A login, key or token is never written
  to a card: credentials never live in Markdown (non-negotiable 1). A test
  fails if a card ever writes a key named like one.

**What a simplification would cost.** A card per seat would drift: the same
person's number would differ between areas. A card on the account would leak
across workspaces the person did not choose to share it with.

**Shared workspaces only** (decided by the owner, 2026-11-24). In a personal
workspace one person owns every area, so its Areas folder is the plain file
listing, with no seats and no List · Chart switch. `areasPage.test.ts` fails if
a personal workspace draws seats.

**Who holds a seat** (decided by the owner, 2026-11-24): a person from the
workspace, optionally with one bot, Tex or agent acting for them there (the
seat's `delegate`), or an agent on its own with no delegate, chosen from the workspace's `agents:` list. The pop-up offers only
those: owner words merely found in other notes are never offered.
`areasPage.test.ts` fails if they are.

**Readings** come from each area's `metrics.csv`: the latest value and a
sparkline against the target, on the List and the Chart (`Trend.tsx`,
`headline.ts`; `areaReadings.test.ts` fails if the target line leaves the
series' scale).

**Sources.** An area's metric is becoming a workspace metric it picks by name,
worked out from the Data folder's datasets
([data-and-metrics](../data-and-metrics.md), 2026-11-24); an area's own
`metrics.csv` keeps working until then.

**Bots** hold seats too, with a prompt that names their area and one delegate per area: [area-bots](./area-bots.md) (2026-11-25).

## A project serves an area, said by one line in the project

*Decided by the owner, 2026-11-25* (the "Projects in areas" boards).

**Why.** An area's metric moves because of projects, and projects live in the
Projects folder with no line back, so an area could not show its work, and
nobody could see the link an agent had written. Moving projects into areas
would break the Projects List and Board; a second copy would drift.

**What it is.** A project stays in the Projects folder and names the area it
serves with `area: areas/<folder>` in its front note: the line area bots
already write and `orient { area }` already reads. One project, one area. The
Areas List ends each area row with a count of its projects in progress (the
in-progress group of the Projects folder's own status list, so custom words
count), sub-areas' included because a folded row hides them, drawn with the
Projects List's half-filled circle; pressing it unfolds them. The area panel
lists them, folds not started and done into one line, and "Attach a project"
writes the line, × removes it. The other way, a project row on the Projects
List (and its Board card) shows its area as a quiet tag, "No area" only for one
in progress, and a project's page adds "area Finance" to its property line,
picked by name, never typed. A count of projects with no area on the top row
was drawn and cut by the owner ("no need for this").

**What it reads.** The Projects folder's front matter through the same read
the Projects page makes, at the viewer's clearance, so a project somebody
cannot see never adds to their count. No body is read and nothing new is
stored (`areas/areaProjects.ts`; `areaProjects.test.ts` fails if a sibling
sharing a prefix is counted or a not-in-progress project is).

**It follows the area.** The line is a reference, so it follows what it
points at, as a link does: moving or renaming an area's folder points every
project's `area:` line at the new folder, in both move engines, at the mover's
clearance and never at a name the project's own readers cannot open
(`apps/mcp/src/moves/areaLines.js`; `areaLines.test.mjs` and
`linkRepair.test.ts` fail if it stops). The area counts as moved when its front
note moved and kept its name; one note moved out of the folder is not the area
moving. An AI client attaches and detaches with `manage { action: "area",
args: { attach, detach } }`, which writes the same line.

**Not built yet.** Tex previewing a change on the Chart as it
is typed. Tex already sets a seat or a card by writing the note.
