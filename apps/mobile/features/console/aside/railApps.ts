import { ASIDE_TABS, type AsideTab } from "./tabs";

/**
 * Where each app on the right rail opens: the one place that says so.
 *
 * **Above the rail's rule, full-page apps; below it, side-panel apps** (Dev,
 * 2026-11-26, a standing rule: "above the line these should be full page apps,
 * below the line side panel apps"). A full-page app is drawn where the note is
 * (the map, Agent Mail) and a click in the left sidebar leaves it
 * (`layout/leaveFullPage.ts`). A side-panel app opens in the panel beside the
 * page and never replaces it (Calendar, Tex, the vault, an area's bot, the
 * map's Activity and Note).
 *
 * The panel toggle leads the rail above the rule. It is the panel's own
 * control, not an app, so it is not listed here.
 *
 * Adding an app to the rail means adding it here, on the side of the rule that
 * matches how it opens; `__tests__/railApps.test.ts` fails when the rail draws
 * an app this list does not place, or draws one on the wrong side.
 */
export type RailOpens = "page" | "panel";

/** Above the rule, in the rail's order: each opens a full page in the note's place. */
export const RAIL_PAGE_APPS = [
  /*
    Search opens the ⌘K palette, which takes over the whole page, so it counts
    as a full page (Dev, 2026-11-26: "pop up takes over the whole page so it
    still works"); it stays the palette rather than the search page.
  */
  "search",
  "map",
  "mail",
] as const;

export type RailPageApp = (typeof RAIL_PAGE_APPS)[number];

/** Below the rule, in the rail's order: every side-panel tab. */
export const RAIL_PANEL_APPS: readonly AsideTab[] = ASIDE_TABS.map((tab) => tab.key);

export type RailApp = RailPageApp | AsideTab;

/** How an app on the rail opens, read off which side of the rule it sits. */
export function railOpens(app: RailApp): RailOpens {
  return (RAIL_PAGE_APPS as readonly string[]).includes(app) ? "page" : "panel";
}
