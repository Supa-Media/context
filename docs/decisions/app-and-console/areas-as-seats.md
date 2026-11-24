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
  `helper`, `modes` (Visionary, Manager, Doer: labels, never rules), `metrics`
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
  area under that top row with guide lines on the left and shows at most
  three notes per area, the rest behind "Show N more".
- **A number is shown against its target** (the owner, 2026-11-24: "it's
  hard to know whether we're doing good or bad"). A box shows its first
  metric's latest value, green on target and amber off it, with "Target
  under 800 ms" beneath; a list row shows `1436 ms / < 800 ms`. Times compare
  across units (`readings.ts`), and a missed target turns the title dot amber.
  An empty seat says "No owner" itself, as a dashed box with Assign owner.
  "No manager loop", flagged for modes without Manager, was removed the same
  day: modes are labels, never rules.

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
- **A person's card**: `phone`, `email`, and a `delegation` agent (the name
  replaces "main agent"): `Tex`, another bot's name with `delegation_how`, or
  none.
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
workspace, optionally with their agent (the seat's `helper`), or an agent on
its own, chosen from the workspace's `agents:` list. The pop-up offers only
those: owner words merely found in other notes are never offered.
`areasPage.test.ts` fails if they are.

**Readings** come from each area's `metrics.csv`: the latest value and a
sparkline, on the List and the Chart.

**Not built yet.** Webhook and
routine sources for a metric, and Tex previewing a change on the Chart as it
is typed. Tex already sets a seat or a card by writing the note.
