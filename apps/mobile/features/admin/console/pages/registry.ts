/**
 * The console's pages, in the artifact's sidebar order (`PAGES`): sections, names, icons, and the
 * page module behind each. The "Cut and merged" page was the artifact's own and is not built.
 */
import { setRoutes } from "../state";
import type { ConsolePage } from "../types";
import { costsPage } from "./Costs.web";
import { credentialsPage } from "./Credentials.web";
import { flagsPage } from "./Flags.web";
import { growthPage } from "./Growth.web";
import { homePage } from "./Home.web";
import { jobsPage } from "./Jobs.web";
import { peoplePage } from "./People.web";
import { reportsPage } from "./Reports.web";
import { searchPage } from "./Search.web";
import { settingsPage } from "./Settings.web";
import { storagePage } from "./Storage.web";
import { turnsPage } from "./Turns.web";
import { usagePage } from "./Usage.web";

export { hashForOldPath } from "../oldPaths";

export type NavRow = { key: string; name: string; icon: string; page: ConsolePage };

export const SECTIONS: Array<[string | null, NavRow[]]> = [
  [null, [{ key: "home", name: "Home", icon: "home", page: homePage }]],
  [
    "People",
    [
      { key: "people", name: "People", icon: "people", page: peoplePage },
      { key: "reports", name: "Reports", icon: "report", page: reportsPage },
    ],
  ],
  [
    "Growth",
    [
      { key: "growth", name: "Growth", icon: "growth", page: growthPage },
      { key: "usage", name: "Usage", icon: "usage", page: usagePage },
    ],
  ],
  [
    "AI",
    [
      { key: "turns", name: "Turns", icon: "text", page: turnsPage },
      { key: "costs", name: "AI costs", icon: "cost", page: costsPage },
      { key: "jobs", name: "Jobs", icon: "jobs", page: jobsPage },
    ],
  ],
  [
    "Platform",
    [
      { key: "storage", name: "Storage", icon: "box", page: storagePage },
      { key: "search", name: "Search", icon: "search", page: searchPage },
      { key: "credentials", name: "Credentials", icon: "key", page: credentialsPage },
      { key: "flags", name: "Flags", icon: "flag", page: flagsPage },
      { key: "settings", name: "Settings", icon: "gear", page: settingsPage },
    ],
  ],
];

export const ROWS: NavRow[] = SECTIONS.flatMap(([, rows]) => rows);
export const ROW: Record<string, NavRow> = Object.fromEntries(ROWS.map((r) => [r.key, r]));

const filters: Record<string, [string, string[]]> = {};
for (const r of ROWS)
  for (const [k, d] of Object.entries(r.page.filters ?? {})) {
    if (filters[k] && filters[k][0] !== d) throw new Error(`console filter ${k} has two defaults`);
    filters[k] = [d, [...(filters[k]?.[1] ?? []), r.key]];
  }

setRoutes({
  pages: ROWS.map((r) => r.key),
  windowed: new Set(ROWS.filter((r) => r.page.windowed).map((r) => r.key)),
  filters,
  // The artifact's `#waitlist--<view>` and `#people--<view>` addresses: People's status filter now.
  alias: (parts) => {
    const WLV: Record<string, string> = { waiting: "waiting", in: "in", removed: "removed", invites: "invited" };
    if (parts[0] === "waitlist") return ["people", "ps-" + (WLV[parts[1]] ?? "waiting"), ...parts.slice(WLV[parts[1]] ? 2 : 1)];
    if (parts[0] === "people" && WLV[parts[1]]) return ["people", "ps-" + WLV[parts[1]], ...parts.slice(2)];
    return parts;
  },
});

/** Whether the page shows the time window now (Search's Indexes view has none). */
export const windowedNow = (key: string) => {
  const w = ROW[key]?.page.windowed;
  return typeof w === "function" ? w() : !!w;
};
