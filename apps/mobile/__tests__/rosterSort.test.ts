/**
 * The Growth roster's order: most active first, ties by newest signup, blanks
 * last either way, and people not signed up below every account.
 */

import { describe, expect, test } from "@jest/globals";
import type { RosterEntry, RosterRow } from "../features/admin/growth";
import { DEFAULT_ROSTER_SORT, nextRosterSort, sortRoster } from "../features/admin/rosterSort";

function account(email: string, over: Partial<RosterRow> = {}): RosterEntry {
  const row: RosterRow = {
    email,
    joinedAt: 1,
    lastSeenAt: null,
    contexts: 1,
    owned: 1,
    connectedStorage: 0,
    clients: 0,
    plan: "none",
    aiSpendMicroUsd: 0,
    aiSpendPartial: false,
    letInAt: null,
    phone: null,
    ...over,
  };
  return { kind: "account", at: row.joinedAt, row };
}

const order = (entries: RosterEntry[]) => entries.map((e) => (e.kind === "account" ? e.row.email : e.row.email));

describe("the roster's order", () => {
  const entries: RosterEntry[] = [
    account("old-active@x.test", { joinedAt: 1, lastSeenAt: 500 }),
    account("never-seen-new@x.test", { joinedAt: 90 }),
    account("never-seen-old@x.test", { joinedAt: 10 }),
    { kind: "not-signed-up", at: 999, row: { email: "pending@x.test", letInAt: 999 } },
    account("tie-new@x.test", { joinedAt: 50, lastSeenAt: 300 }),
    account("tie-old@x.test", { joinedAt: 20, lastSeenAt: 300 }),
  ];

  test("by default: most recently seen first, ties and the never-seen by newest signup, pending last", () => {
    expect(order(sortRoster(entries, DEFAULT_ROSTER_SORT))).toEqual([
      "old-active@x.test",
      "tie-new@x.test",
      "tie-old@x.test",
      "never-seen-new@x.test",
      "never-seen-old@x.test",
      "pending@x.test",
    ]);
  });

  test("flipping a column keeps blanks at the bottom", () => {
    const flipped = nextRosterSort(DEFAULT_ROSTER_SORT, "seen");
    expect(flipped).toEqual({ key: "seen", dir: "asc" });
    expect(order(sortRoster(entries, flipped)).slice(0, 3)).toEqual(["tie-new@x.test", "tie-old@x.test", "old-active@x.test"]);
    expect(order(sortRoster(entries, flipped)).at(-1)).toBe("pending@x.test");
  });

  test("a new column starts high to low, addresses A to Z", () => {
    expect(nextRosterSort(DEFAULT_ROSTER_SORT, "joined")).toEqual({ key: "joined", dir: "desc" });
    expect(nextRosterSort(DEFAULT_ROSTER_SORT, "account")).toEqual({ key: "account", dir: "asc" });
    expect(order(sortRoster(entries, { key: "joined", dir: "desc" }))[0]).toBe("never-seen-new@x.test");
  });

  test("Tex access sorts by whether the phone is on the list; no phone goes last", () => {
    const tex: RosterEntry[] = [
      account("off@x.test", { phone: "+15550000002" }),
      account("none@x.test"),
      account("on@x.test", { phone: "+15550000001" }),
    ];
    expect(order(sortRoster(tex, { key: "tex", dir: "desc" }, new Set(["+15550000001"])))).toEqual([
      "on@x.test",
      "off@x.test",
      "none@x.test",
    ]);
  });
});
