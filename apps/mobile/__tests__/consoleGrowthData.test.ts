/**
 * The console's Growth page as data (`features/admin/console/pages/growthData.ts`), in the staff console mock's
 * wording (`staff-console.html`). Pure functions: no React, no native modules.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DAY_MS,
} from "../features/admin/console/pages/homeData";
import {
  displayName,
  firstName,
  fromPill,
  funnelRows,
  growthFunnel,
  growthTiles,
  monthDay,
  newestArrivals,
  nudges,
  AWAY_MS,
  type CensusLike,
  type PersonLike,
  type UsageLike,
} from "../features/admin/console/pages/growthData";

const NOW = 1_000_000_000_000;
const DAY = DAY_MS;

// -- growthData --------------------------------------------------------------------------------------------------------

describe("funnelRows", () => {
  test("each bar is a share of the first step", () => {
    const rows = funnelRows([
      { step: "let-in", count: 31 },
      { step: "signed-up", count: 20 },
    ]);
    expect(rows[0]).toEqual({ label: "Let in from the waitlist", count: 31, pct: 100, width: 100 });
    expect(rows[1]?.pct).toBe(65);
    expect(rows[1]?.width).toBeCloseTo((20 / 31) * 100, 10);
  });

  test("step names map to the mock's labels, and an unknown step keeps its id", () => {
    const rows = funnelRows([
      { step: "texted-tex", count: 4 },
      { step: "connected-a-client", count: 2 },
      { step: "in-a-shared-workspace", count: 1 },
      { step: "mystery", count: 1 },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Texted Tex", "Connected an AI client", "In a shared workspace", "mystery"]);
  });

  test("an empty funnel draws nothing", () => {
    expect(funnelRows([])).toEqual([]);
  });

  test("a first step of zero leaves every bar at zero, not NaN", () => {
    const rows = funnelRows([
      { step: "signed-up", count: 0 },
      { step: "texted-tex", count: 3 },
    ]);
    expect(rows.map((r) => [r.pct, r.width])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });
});

describe("growthFunnel", () => {
  const census: CensusLike = {
    accounts: { total: { count: 14, isFloor: false }, newInWindow: 3 },
    contexts: { total: { count: 9, isFloor: false }, personal: 6, shared: 3 },
    growthFunnel: [
      { step: "signed-up", count: 14 },
      { step: "texted-tex", count: 7 },
    ],
    waitlist: {
      growthFunnel: [
        { step: "let-in", count: 31 },
        { step: "signed-up", count: 20 },
      ],
    },
  };

  test("the everyone audience uses the whole funnel", () => {
    expect(growthFunnel(census, "all").map((r) => [r.label, r.count, r.pct])).toEqual([
      ["Signed up", 14, 100],
      ["Texted Tex", 7, 50],
    ]);
  });

  test("the waitlist audience uses the waitlist's funnel", () => {
    expect(growthFunnel(census, "wait").map((r) => [r.label, r.count, r.pct])).toEqual([
      ["Let in from the waitlist", 31, 100],
      ["Signed up", 20, 65],
    ]);
  });

  test("the waitlist audience stops at 'Connected an AI client', four rows as the artifact draws it", () => {
    const steps = ["let-in", "signed-up", "texted-tex", "connected-a-client", "in-a-shared-workspace"];
    const five: CensusLike = { ...census, waitlist: { growthFunnel: steps.map((step, i) => ({ step, count: 31 - i * 5 })) } };
    expect(growthFunnel(five, "wait").map((r) => r.label)).toEqual([
      "Let in from the waitlist",
      "Signed up",
      "Texted Tex",
      "Connected an AI client",
    ]);
    expect(growthFunnel({ ...five, growthFunnel: steps.slice(1).map((step) => ({ step, count: 1 })) }, "all")).toHaveLength(4);
  });

  test("a census without a funnel gives an empty funnel", () => {
    expect(growthFunnel({ ...census, growthFunnel: undefined }, "all")).toEqual([]);
    expect(growthFunnel({ ...census, waitlist: {} }, "wait")).toEqual([]);
  });
});

describe("growthTiles", () => {
  const census: CensusLike = {
    accounts: { total: { count: 14, isFloor: false }, newInWindow: 3 },
    contexts: { total: { count: 9, isFloor: false }, personal: 6, shared: 3 },
    waitlist: {},
    texAccess: { canText: 9, phoneButOff: 2 },
  };
  const usage: UsageLike = {
    activeContexts: {
      points: [
        { day: "2026-11-13", count: 5 },
        { day: "2026-11-14", count: 4 },
      ],
      distinctInWindow: 7,
    },
  };
  const byKey = (tiles: ReturnType<typeof growthTiles>) => Object.fromEntries(tiles.map((t) => [t.key, t]));

  test("the four tiles read as the mock does", () => {
    const t = byKey(growthTiles(census, usage));
    expect(t.accounts).toEqual({ key: "accounts", label: "Accounts", value: "14", detail: "+3 in 30 days" });
    expect(t.workspaces?.detail).toBe("6 personal · 3 shared");
    expect(t.active).toEqual({ key: "active", label: "Active workspaces", value: "7", detail: "4 today" });
    expect(t.tex).toEqual({ key: "tex", label: "Can text Tex", value: "9", detail: "2 with a phone but switched off" });
  });

  test("a floor count shows a plus, and thousands are grouped", () => {
    const big: CensusLike = { ...census, accounts: { total: { count: 1234, isFloor: true }, newInWindow: 0 } };
    expect(growthTiles(big, usage)[0]?.value).toBe("1,234+");
  });

  test("active workspaces reads an em dash without usage, and no 'today' line", () => {
    const t = byKey(growthTiles(census, null)).active;
    expect(t?.value).toBe("—");
    expect(t?.detail).toBe("");
  });

  test("with usage but no points today reads zero today", () => {
    const t = byKey(growthTiles(census, { activeContexts: { points: [], distinctInWindow: 0 } })).active;
    expect(t?.value).toBe("0");
    expect(t?.detail).toBe("0 today");
  });

  test("can text Tex reads an em dash when the access numbers are missing", () => {
    const t = byKey(growthTiles({ ...census, texAccess: undefined }, usage)).tex;
    expect(t?.value).toBe("—");
    expect(t?.detail).toBe("");
  });
});

describe("displayName and firstName", () => {
  const base: PersonLike = {
    id: "p1",
    name: null,
    handle: null,
    emails: [],
    phone: null,
    joinedAt: NOW,
    from: null,
    invitedBy: null,
    clients: 0,
    lastSeenAt: NOW,
  };

  test("the name wins when there is one", () => {
    expect(displayName({ ...base, name: "Sam Ray", handle: "samw" })).toBe("Sam Ray");
  });

  test("then the handle, with an at sign", () => {
    expect(displayName({ ...base, handle: "samw", emails: ["a@example.com"] })).toBe("@samw");
  });

  test("then the first address, then the phone, then a question mark", () => {
    expect(displayName({ ...base, emails: ["a@example.com", "b@example.com"] })).toBe("a@example.com");
    expect(displayName({ ...base, phone: "+15555550100" })).toBe("+15555550100");
    expect(displayName(base)).toBe("?");
  });

  test("an empty name is treated as no name", () => {
    expect(displayName({ ...base, name: "", handle: "samw" })).toBe("@samw");
  });

  test("firstName is the first word of the display name", () => {
    expect(firstName({ ...base, name: "Sam Ray" })).toBe("Sam");
    expect(firstName({ ...base, handle: "samw" })).toBe("@samw");
    expect(firstName(base)).toBe("?");
  });
});

describe("fromPill", () => {
  const base: PersonLike = {
    id: "p1",
    name: "Sam",
    handle: null,
    joinedAt: NOW,
    from: null,
    invitedBy: null,
    clients: 0,
    lastSeenAt: NOW,
  };

  test("a waitlist sign-up reads 'waitlist' in the plain tone", () => {
    expect(fromPill({ ...base, from: "waitlist" })).toEqual({ text: "waitlist", tone: "" });
  });

  test("a friend reads 'invited by' the inviter's first name, as the artifact has it, in the team tone", () => {
    const maya = { ...base, id: "u-maya", name: "Maya Lindqvist", handle: "maya" };
    expect(fromPill({ ...base, from: "friend", invitedBy: "maya" }, [maya])).toEqual({ text: "invited by Maya", tone: "team" });
  });

  test("a friend invited by somebody not in the list reads their @handle, never a bare handle", () => {
    expect(fromPill({ ...base, from: "friend", invitedBy: "ana" })).toEqual({ text: "invited by @ana", tone: "team" });
  });

  test("a friend with nobody named reads 'invited'", () => {
    expect(fromPill({ ...base, from: "friend", invitedBy: null })).toEqual({ text: "invited", tone: "team" });
  });

  test("an ad reads 'ad' in the warn tone", () => {
    expect(fromPill({ ...base, from: "ad" })).toEqual({ text: "ad", tone: "warn" });
  });

  test("staff, direct and unknown sign-ups get no pill", () => {
    expect(fromPill({ ...base, from: "staff" })).toBeNull();
    expect(fromPill({ ...base, from: "direct" })).toBeNull();
    expect(fromPill({ ...base, from: null })).toBeNull();
  });
});

describe("monthDay", () => {
  test("is month then day, zero-padded, in UTC", () => {
    expect(monthDay(Date.UTC(2026, 10, 14))).toBe("11/14");
    expect(monthDay(Date.UTC(2026, 0, 5))).toBe("01/05");
  });

  test("uses the UTC day even late in the UTC evening", () => {
    expect(monthDay(Date.UTC(2026, 10, 14, 23, 30))).toBe("11/14");
  });
});

describe("newestArrivals", () => {
  const person = (id: string, joinedAt: number | null, extra: Partial<PersonLike> = {}): PersonLike => ({
    id,
    name: id,
    handle: null,
    joinedAt,
    from: null,
    invitedBy: null,
    clients: 0,
    lastSeenAt: null,
    ...extra,
  });

  test("sorts newest first and keeps five by default", () => {
    const people = [1, 2, 3, 4, 5, 6, 7].map((i) => person(`p${i}`, NOW + i));
    const got = newestArrivals(people);
    expect(got.map((p) => p.id)).toEqual(["p7", "p6", "p5", "p4", "p3"]);
  });

  test("excludes archived people and people who never joined", () => {
    const people = [
      person("old", NOW - 5 * DAY),
      person("archived", NOW + 100, { archived: true }),
      person("waiting", null),
      person("new", NOW),
    ];
    expect(newestArrivals(people).map((p) => p.id)).toEqual(["new", "old"]);
  });

  test("takes the count asked for and does not reorder the input", () => {
    const people = [person("a", NOW - 2), person("b", NOW - 1), person("c", NOW)];
    expect(newestArrivals(people, 2).map((p) => p.id)).toEqual(["c", "b"]);
    expect(people.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
});

describe("nudges", () => {
  const person = (id: string, extra: Partial<PersonLike> = {}): PersonLike => ({
    id,
    name: id,
    handle: null,
    joinedAt: NOW - 10 * DAY,
    from: null,
    invitedBy: null,
    clients: 1,
    lastSeenAt: NOW,
    phone: "+15555550100",
    ...extra,
  });
  const find = (rows: ReturnType<typeof nudges>, label: string) => rows.find((r) => r.label === label)?.people.map((p) => p.id);

  test("the three rows come in the mock's order", () => {
    expect(nudges([], NOW).map((r) => r.label)).toEqual(["No AI client", "Never came back", "No phone for Tex"]);
  });

  test("no AI client lists accounts with zero connected clients", () => {
    const rows = nudges([person("none", { clients: 0 }), person("some", { clients: 2 })], NOW);
    expect(find(rows, "No AI client")).toEqual(["none"]);
  });

  test("never came back: last seen more than 100 hours ago, as the artifact's lastN > 100", () => {
    const H = 3_600_000;
    const rows = nudges(
      [
        person("sam", { joinedAt: NOW - 40 * DAY, lastSeenAt: NOW - 288 * H }),
        person("kai", { joinedAt: NOW - 5 * DAY, lastSeenAt: NOW - 144 * H }),
        person("leo", { joinedAt: NOW - 60 * DAY, lastSeenAt: NOW - 72 * H }),
        person("maya", { joinedAt: NOW - 90 * DAY, lastSeenAt: NOW - 2 * H }),
      ],
      NOW,
    );
    expect(find(rows, "Never came back")).toEqual(["sam", "kai"]);
  });

  test("never came back: exactly 100 hours is not yet, one millisecond more is", () => {
    const exact = nudges([person("exact", { joinedAt: NOW - 9 * DAY, lastSeenAt: NOW - AWAY_MS })], NOW);
    const older = nudges([person("older", { joinedAt: NOW - 9 * DAY, lastSeenAt: NOW - AWAY_MS - 1 })], NOW);
    expect(find(exact, "Never came back")).toEqual([]);
    expect(find(older, "Never came back")).toEqual(["older"]);
  });

  test("never came back: somebody never seen counts from when they joined, so a new account is not on it", () => {
    const fresh = nudges([person("fresh", { joinedAt: NOW - 3_600_000, lastSeenAt: null })], NOW);
    const stale = nudges([person("stale", { joinedAt: NOW - 5 * DAY, lastSeenAt: null })], NOW);
    expect(find(fresh, "Never came back")).toEqual([]);
    expect(find(stale, "Never came back")).toEqual(["stale"]);
  });

  test("no phone for Tex lists accounts without a phone, empty or missing", () => {
    const rows = nudges(
      [person("null", { phone: null }), person("empty", { phone: "" }), person("has", { phone: "+15555550100" })],
      NOW,
    );
    expect(find(rows, "No phone for Tex")).toEqual(["null", "empty"]);
  });

  test("archived people and people still waiting are in no nudge", () => {
    const rows = nudges(
      [person("archived", { clients: 0, phone: null, archived: true }), person("waiting", { joinedAt: null, clients: 0 })],
      NOW,
    );
    expect(rows.every((r) => r.people.length === 0)).toBe(true);
  });
});
