# App and console — the right rail: full pages above the rule, side panels below

## Above the rail's rule, full-page apps; below it, side-panel apps (2026-11-26)

Dev, 2026-11-26, as a standing rule: "above the line these should be full page
apps, below the line side panel apps, also can you make the line a little more
pronounced".

The right rail is one column of buttons split by a rule:

- **Above the rule** (after the panel toggle, which is the panel's own control
  and not an app): **full-page apps**, drawn where the note is: search, the live
  map, Agent Mail. A click in the left sidebar leaves them
  (`layout/leaveFullPage.ts`).
- **Below the rule**: **side-panel apps**, opened in the panel beside the page,
  never replacing it: Calendar (Meetings), Tex, the vault, an area's bot, and
  the map's Activity and Note tabs.

Search opens the ⌘K palette, not the search page, and that fits the rule: the
palette takes over the whole page (Dev, 2026-11-26, asked whether the rail's
magnifier should open the full search page instead: "pop up takes over the
whole page so it still works").

**Where it is encoded:** `apps/mobile/features/console/aside/railApps.ts` is the
one list of which app opens how (`RAIL_PAGE_APPS`, `RAIL_PANEL_APPS`,
`railOpens`); `AsideStrip.tsx` draws the page apps above the rule from it and
the panel tabs below. A new rail app is added there, on the side that matches
how it opens. A new full page also joins `leaveFullPages`.

The rule itself is a full pixel in `lineStrong`, 24 wide, rather than a hairline
in `line`, so the two groups read as two.

**What a simplification would cost:** an app that opens a page drawn below the
rule, or a panel drawn above it, makes the rail lie about what a press will do,
which is the confusion this rule exists to end.

**The test that fails:** `apps/mobile/__tests__/railApps.test.ts` reads the
rail's drawn order and fails when an app sits on the wrong side of the rule,
when a page app's press opens the panel, or when an app is on both lists.
