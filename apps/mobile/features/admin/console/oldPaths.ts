/**
 * The old console's tabs, `/admin/<tab>[/<view>]`, and the page each became, so a bookmark still
 * lands. The old waitlist views are People's status filter now.
 */
export const OLD_TABS: Record<string, string> = {
  growth: "growth",
  estate: "storage",
  activity: "usage",
  usage: "usage",
  agent: "turns",
  aiCosts: "costs",
  ai: "jobs",
  search: "search",
  credentials: "credentials",
  waitlist: "people--ps-waiting",
  people: "people",
  reports: "reports",
  features: "flags",
};
const WAITLIST_VIEW: Record<string, string> = { "let-in": "in", removed: "removed", friends: "invited", waiting: "waiting" };

/** The console hash an old `/admin/...` path means, or null when it names no old tab. */
export function hashForOldPath(path: string): string | null {
  const [tab, view] = path.replace(/^\/admin\/?/, "").split("/").filter(Boolean);
  if (!tab || !OLD_TABS[tab]) return null;
  if (tab === "waitlist") return "#people--ps-" + (WAITLIST_VIEW[view ?? ""] ?? "waiting");
  return "#" + OLD_TABS[tab];
}
