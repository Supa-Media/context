/**
 * The roster's order (Dev2, 2026-10-13: "make the columns sortable as well,
 * by default i wanna see the most active on top, and then sort by most recent
 * signed up").
 *
 * The default is Last seen, newest first, and every tie (two people seen the
 * same moment, or never seen) falls back to who signed up most recently. A
 * missing value (never seen, no phone) goes last whichever way the column is
 * turned, so flipping a column never fills the top with blanks. People let in
 * who have not signed up are not accounts, so they stay below the accounts,
 * newest let in first.
 */

import type { SortDirection } from "./AdminTable";
import type { RosterEntry, RosterRow } from "./growth";

export type RosterSortKey = "account" | "joined" | "seen" | "workspaces" | "clients" | "ai" | "plan" | "tex";

export interface RosterSort {
  key: RosterSortKey;
  dir: SortDirection;
}

export const DEFAULT_ROSTER_SORT: RosterSort = { key: "seen", dir: "desc" };

const PLAN_RANK: Record<string, number> = { active: 4, past_due: 3, canceled: 2, unknown: 1, none: 0 };

/** A column pressed: the same column flips; a new one starts high to low, or A to Z for addresses. */
export function nextRosterSort(current: RosterSort, key: RosterSortKey): RosterSort {
  if (current.key === key) return { key, dir: current.dir === "desc" ? "asc" : "desc" };
  return { key, dir: key === "account" ? "asc" : "desc" };
}

function valueOf(row: RosterRow, key: RosterSortKey, texListed: ReadonlySet<string>): number | string | null {
  switch (key) {
    case "account":
      return row.email?.toLowerCase() ?? null;
    case "joined":
      return row.joinedAt;
    case "seen":
      return row.lastSeenAt;
    case "workspaces":
      return row.contexts;
    case "clients":
      return row.clients;
    case "ai":
      return row.aiSpendMicroUsd;
    case "plan":
      return PLAN_RANK[row.plan] ?? 0;
    case "tex":
      return row.phone ? (texListed.has(row.phone) ? 1 : 0) : null;
  }
}

export function sortRoster(
  entries: readonly RosterEntry[],
  sort: RosterSort,
  texListed: ReadonlySet<string> = new Set(),
): RosterEntry[] {
  const accounts = entries.filter((e): e is Extract<RosterEntry, { kind: "account" }> => e.kind === "account");
  const pending = entries.filter((e) => e.kind === "not-signed-up").sort((a, b) => b.at - a.at);
  const sign = sort.dir === "desc" ? -1 : 1;
  accounts.sort((a, b) => {
    const x = valueOf(a.row, sort.key, texListed);
    const y = valueOf(b.row, sort.key, texListed);
    if (x !== y) {
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sign;
    }
    return b.row.joinedAt - a.row.joinedAt;
  });
  return [...accounts, ...pending];
}
