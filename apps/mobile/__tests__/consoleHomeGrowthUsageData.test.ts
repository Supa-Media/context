/**
 * The console's Home, Growth and Usage pages as data (`features/admin/console/pages/{homeData,growthData,usageData}.ts`).
 *
 * The wording is the staff console mock's (`staff-console.html`, `P.home`, `needsList`, `P.growth`, `P.usage`), so a
 * person reading the page reads what the mock showed. These are pure functions: no React, no native modules.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DAY_MS,
  delta,
  homeTiles,
  money,
  needsList,
  percentChange,
  plural,
  windowRange,
  type CostsLike,
  type NeedsSources,
  type TexStatsLike,
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
  type CensusLike,
  type PersonLike,
  type UsageLike,
} from "../features/admin/console/pages/growthData";
import {
  ago,
  analyticsNote,
  captureRows,
  clientRows,
  eventRows,
  journeys,
  usageTiles,
  type AnalyticsLike,
  type ClientLike,
  type Series,
} from "../features/admin/console/pages/usageData";

const NOW = 1_000_000_000_000;
const DAY = DAY_MS;

// -- homeData ----------------------------------------------------------------------------------------------------------

describe("windowRange", () => {
  test("the window ends now and the prior window is the same length before it", () => {
    expect(windowRange("7", NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW, priorFrom: NOW - 14 * DAY });
  });

  test("the 24-hour window is one day long", () => {
    const r = windowRange("1", NOW);
    expect(r.to - r.from).toBe(DAY);
    expect(r.from - r.priorFrom).toBe(DAY);
  });

  test("the 90-day window spans ninety days", () => {
    const r = windowRange("90", NOW);
    expect(r.to - r.from).toBe(90 * DAY);
    expect(r.priorFrom).toBe(NOW - 180 * DAY);
  });
});

describe("money", () => {
  test("formats dollars with two digits and thousands separators, as the mock does", () => {
    expect(money(1234.5)).toBe("$1,234.50");
    expect(money(4.7)).toBe("$4.70");
  });

  test("a sub-cent price keeps its digits when asked for more", () => {
    expect(money(0.16)).toBe("$0.16");
    expect(money(0.1234, 4)).toBe("$0.1234");
  });

  test("a non-finite amount reads as zero rather than NaN", () => {
    expect(money(Number.NaN)).toBe("$0.00");
    expect(money(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
});

describe("plural", () => {
  test("uses the singular only for exactly one", () => {
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(2, "person", "people")).toBe("2 people");
    expect(plural(0, "turn", "turns")).toBe("0 turns");
  });
});

describe("delta", () => {
  test("a rise is signed and good only when up is good", () => {
    expect(delta(12, true, "%")).toEqual({ text: "+12%", good: true });
    expect(delta(12, false, "%")).toEqual({ text: "+12%", good: false });
  });

  test("a fall is shown with its minus and good only when down is good", () => {
    expect(delta(-3, true, "%")).toEqual({ text: "-3%", good: false });
    expect(delta(-3, false, "%")).toEqual({ text: "-3%", good: true });
  });

  test("rounds to two places", () => {
    expect(delta(-0.0345, true).text).toBe("-0.03");
    expect(delta(38.4, true, "s").text).toBe("+38.4s");
    expect(delta(38.456, true, "s").text).toBe("+38.46s");
  });
});

describe("percentChange", () => {
  test("is the change against the prior value, rounded to a whole percent", () => {
    expect(percentChange(12, 10)).toBe(20);
    expect(percentChange(1240, 1107)).toBe(12);
    expect(percentChange(0, 5)).toBe(-100);
  });

  test("is null when there was nothing before to compare with", () => {
    expect(percentChange(5, 0)).toBeNull();
    expect(percentChange(5, -1)).toBeNull();
  });
});

describe("homeTiles", () => {
  const stats: TexStatsLike = {
    configured: true,
    dailyActive: 6.44,
    people: { one: 6, group: 4, any: 9, accounts: 6, guests: 3 },
    texts: { inOne: 1000, inGroup: 234, outOne: 0, outGroup: 0 },
    cost: { totalUsd: 4.7 },
    costPerTextUsd: 0.16,
    series: [
      { at: 1, people: 2, textsIn: 5, usd: 0.5 },
      { at: 2, people: 3, textsIn: 0, usd: 0 },
    ],
  };
  const costs: CostsLike = {
    totalUsd: 4.7,
    outOfPocketUsd: 1.8,
    perTextUsd: 0.16,
    priorPerTextUsd: 0.19,
    daily: [{ usd: 1 }, { usd: 2 }],
  };
  const byKey = (tiles: ReturnType<typeof homeTiles>) => Object.fromEntries(tiles.map((t) => [t.key, t]));

  test("the five tiles come in the mock's order, each opening its page", () => {
    const tiles = homeTiles({ d: "7", stats, costs, accounts: 14, answered: 1000 });
    expect(tiles.map((t) => [t.key, t.go, t.color])).toEqual([
      ["dap", "people", "c5"],
      ["texters", "turns", "c4"],
      ["texts", "turns", "c1"],
      ["cpt", "costs", "c2"],
      ["spent", "costs", "c3"],
    ]);
  });

  test("daily active people reads 'of N people' against the account count", () => {
    const dap = byKey(homeTiles({ d: "7", stats, costs, accounts: 14, answered: null })).dap;
    expect(dap.value).toBe("6.4");
    expect(dap.detail).toBe("of 14 people");
  });

  test("the one-day window shows the people seen in it, whole", () => {
    const dap = byKey(homeTiles({ d: "1", stats, costs, accounts: 14, answered: null })).dap;
    expect(dap.value).toBe("9");
  });

  test("people texting Tex reads '8 with accounts · 4 guests' from the counts given", () => {
    const withCounts: TexStatsLike = { ...stats, people: { one: 6, group: 4, any: 12, accounts: 8, guests: 4 } };
    const t = byKey(homeTiles({ d: "7", stats: withCounts, costs, accounts: 14, answered: null })).texters;
    expect(t.value).toBe("12");
    expect(t.detail).toBe("8 with accounts · 4 guests");
  });

  test("texts received sums one-to-one and group texts and reads 'N answered'", () => {
    const t = byKey(homeTiles({ d: "7", stats, costs, accounts: 14, answered: 1000 })).texts;
    expect(t.value).toBe("1,234");
    expect(t.detail).toBe("1,000 answered");
    expect(t.spark).toEqual([5, 0]);
  });

  test("cost per text delta is good when cost fell", () => {
    const cpt = byKey(homeTiles({ d: "7", stats, costs, accounts: 14, answered: null })).cpt;
    expect(cpt.value).toBe("$0.16");
    expect(cpt.delta).toEqual({ text: "-0.03", good: true });
    expect(cpt.detail).toBe(" vs the window before");
  });

  test("cost per text delta is bad when cost rose", () => {
    const rose: CostsLike = { ...costs, perTextUsd: 0.2, priorPerTextUsd: 0.16 };
    const cpt = byKey(homeTiles({ d: "7", stats, costs: rose, accounts: 14, answered: null })).cpt;
    expect(cpt.delta).toEqual({ text: "+0.04", good: false });
  });

  test("cost per text has no delta without a prior window to compare with", () => {
    const cpt = byKey(homeTiles({ d: "7", stats, costs: { ...costs, priorPerTextUsd: null }, accounts: 14, answered: null })).cpt;
    expect(cpt.delta).toBeUndefined();
    expect(cpt.detail).toBe("");
  });

  test("spent on AI reads the total and 'of it out of pocket'", () => {
    const spent = byKey(homeTiles({ d: "7", stats, costs, accounts: 14, answered: null })).spent;
    expect(spent.value).toBe("$4.70");
    expect(spent.detail).toBe("$1.80 of it out of pocket");
    expect(spent.spark).toEqual([1, 2]);
  });

  test("with stats null every tile that needs them reads an em dash, not a zero", () => {
    const tiles = homeTiles({ d: "7", stats: null, costs: null, accounts: null, answered: null });
    const t = byKey(tiles);
    expect(t.dap.value).toBe("—");
    expect(t.dap.detail).toBe("");
    expect(t.texters.value).toBe("—");
    expect(t.texters.detail).toBe("");
    expect(t.texts.value).toBe("—");
    expect(t.cpt.value).toBe("—");
    expect(t.spent.value).toBe("—");
    expect(t.spent.detail).toBe("");
    expect(t.texts.spark).toEqual([]);
  });

  test("costs alone still fill the spend tiles when stats are null", () => {
    const t = byKey(homeTiles({ d: "7", stats: null, costs, accounts: null, answered: null }));
    expect(t.cpt.value).toBe("$0.16");
    expect(t.spent.value).toBe("$4.70");
    expect(t.spent.detail).toBe("$1.80 of it out of pocket");
  });

  test("the guests count falls back to any minus one when accounts is missing", () => {
    const noAccounts: TexStatsLike = { ...stats, people: { one: 6, group: 4, any: 9 } };
    const t = byKey(homeTiles({ d: "7", stats: noAccounts, costs, accounts: 14, answered: null })).texters;
    expect(t.detail).toBe("6 with accounts · 3 guests");
  });

  test("the guests fallback never goes negative", () => {
    const odd: TexStatsLike = { ...stats, people: { one: 6, group: 4, any: 2 } };
    const t = byKey(homeTiles({ d: "7", stats: odd, costs, accounts: 14, answered: null })).texters;
    expect(t.detail).toBe("6 with accounts · 0 guests");
  });
});

describe("needsList", () => {
  const all: NeedsSources = {
    secretsUnset: 2,
    openReports: { count: 3, viaTex: 2 },
    unfinished: { exhausted: 9, failed: 4 },
    waiting: 5,
    untold: 1,
    failedIndexes: 2,
    failedBackups: ["studio-ops"],
    mailOpen: ["samw"],
  };
  const none: NeedsSources = {
    secretsUnset: undefined,
    openReports: undefined,
    unfinished: undefined,
    waiting: undefined,
    untold: undefined,
    failedIndexes: undefined,
    failedBackups: undefined,
    mailOpen: undefined,
  };

  test("a source that is undefined adds nothing", () => {
    expect(needsList(none)).toEqual([]);
  });

  test("zero counts add nothing either, and nothing reads as 'needs you' only when every source is clear", () => {
    expect(
      needsList({
        secretsUnset: 0,
        openReports: { count: 0, viaTex: 0 },
        unfinished: { exhausted: 0, failed: 0 },
        waiting: 0,
        untold: 0,
        failedIndexes: 0,
        failedBackups: [],
        mailOpen: [],
      }),
    ).toEqual([]);
  });

  test("the items come in the mock's order with every wording and target", () => {
    const list = needsList(all);
    expect(list.map((n) => n.key)).toEqual(["credentials", "reports", "turns", "waiting", "untold", "indexes", "backup", "mail-samw"]);
    expect(list[0]).toEqual({
      key: "credentials",
      tone: "warn",
      bold: "2 credentials",
      rest: " the code expects are not set",
      where: "Credentials",
      target: { page: "credentials" },
    });
    expect(list[1]).toEqual({
      key: "reports",
      tone: "bad",
      bold: "3 open reports",
      rest: ", 2 texted to Tex",
      where: "Reports",
      target: { page: "reports" },
    });
    expect(list[2]).toEqual({
      key: "turns",
      tone: "warn",
      bold: "13 turns",
      rest: " didn't finish (9 ran out of steps, 4 failed)",
      where: "Turns",
      target: { page: "turns", f: { end: "trouble" } },
    });
    expect(list[3]).toEqual({
      key: "waiting",
      tone: "warn",
      bold: "5 people",
      rest: " waiting to be let in",
      where: "People",
      target: { page: "people", f: { ps: "waiting" } },
    });
    expect(list[4]).toEqual({
      key: "untold",
      tone: "warn",
      bold: "1 person",
      rest: " let in by phone but never told",
      where: "People",
      target: { page: "people", f: { ps: "in", told: "no" } },
    });
    expect(list[5]).toEqual({
      key: "indexes",
      tone: "bad",
      bold: "2 workspaces",
      rest: " with a failed search index",
      where: "Search",
      target: { page: "search", subs: ["indexes"] },
    });
    expect(list[6]).toEqual({
      key: "backup",
      tone: "bad",
      bold: "@studio-ops",
      rest: " failed its backup encryption check",
      where: "Storage",
      target: { page: "storage" },
    });
    expect(list[7]).toEqual({
      key: "mail-samw",
      tone: "warn",
      bold: "@samw's mail inbox",
      rest: " takes mail from anyone",
      where: "People",
      target: { page: "people" },
    });
  });

  test("one credential reads singular, with 'is'", () => {
    const [item] = needsList({ ...none, secretsUnset: 1 });
    expect(item?.bold).toBe("1 credential");
    expect(item?.rest).toBe(" the code expects is not set");
  });

  test("one open report with no Tex split reads singular and drops the tail", () => {
    const [item] = needsList({ ...none, openReports: { count: 1, viaTex: null } });
    expect(item?.bold).toBe("1 open report");
    expect(item?.rest).toBe("");
  });

  test("turns that did not finish sum both kinds", () => {
    const [item] = needsList({ ...none, unfinished: { exhausted: 0, failed: 3 } });
    expect(item?.bold).toBe("3 turns");
    expect(item?.rest).toBe(" didn't finish (0 ran out of steps, 3 failed)");
  });

  test("a single failed backup names its workspace and reads 'its'", () => {
    const [item] = needsList({ ...none, failedBackups: ["studio-ops"] });
    expect(item?.tone).toBe("bad");
    expect(item?.bold).toBe("@studio-ops");
  });

  test("several failed backups read as a count and 'their'", () => {
    const [item] = needsList({ ...none, failedBackups: ["a", "b"] });
    expect(item?.bold).toBe("2 workspaces");
    expect(item?.rest).toBe(" failed their backup encryption check");
    expect(item?.target).toEqual({ page: "storage" });
  });

  test("each open mail inbox gets its own row, keyed by slug", () => {
    const list = needsList({ ...none, mailOpen: ["samw", "crystal"] });
    expect(list.map((n) => n.key)).toEqual(["mail-samw", "mail-crystal"]);
    expect(list.map((n) => n.target)).toEqual([{ page: "people" }, { page: "people" }]);
  });
});

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

  test("a friend reads 'invited by' whoever invited them, in the team tone", () => {
    expect(fromPill({ ...base, from: "friend", invitedBy: "Ana" })).toEqual({ text: "invited by Ana", tone: "team" });
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

  test("never came back: an account more than two days old and not seen after its first day", () => {
    const rows = nudges(
      [
        person("gone", { joinedAt: NOW - 3 * DAY, lastSeenAt: NOW - 3 * DAY + 1000 }),
        person("never-seen", { joinedAt: NOW - 3 * DAY, lastSeenAt: null }),
        person("back", { joinedAt: NOW - 3 * DAY, lastSeenAt: NOW - 2 * DAY }),
        person("new", { joinedAt: NOW - DAY, lastSeenAt: NOW - DAY }),
      ],
      NOW,
    );
    expect(find(rows, "Never came back")).toEqual(["gone", "never-seen"]);
  });

  test("never came back: exactly two days old is not yet, one millisecond older is", () => {
    const exact = nudges([person("exact", { joinedAt: NOW - 2 * DAY, lastSeenAt: null })], NOW);
    const older = nudges([person("older", { joinedAt: NOW - 2 * DAY - 1, lastSeenAt: null })], NOW);
    expect(find(exact, "Never came back")).toEqual([]);
    expect(find(older, "Never came back")).toEqual(["older"]);
  });

  test("never came back: seen within the first day counts as not gone, seen exactly a day later does not", () => {
    const joinedAt = NOW - 5 * DAY;
    const within = nudges([person("within", { joinedAt, lastSeenAt: joinedAt + DAY - 1 })], NOW);
    const onDayOne = nudges([person("onday", { joinedAt, lastSeenAt: joinedAt + DAY })], NOW);
    expect(find(within, "Never came back")).toEqual(["within"]);
    expect(find(onDayOne, "Never came back")).toEqual([]);
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

// -- usageData ---------------------------------------------------------------------------------------------------------

describe("usageTiles", () => {
  const ready: AnalyticsLike = {
    connected: true,
    error: null,
    sites: [
      { host: "context.lc", visits: 1240, visitors: 530, priorVisits: 1107 },
      { host: "tex.lc", visits: 860, visitors: 410, priorVisits: 656 },
    ],
    time: { sessions: 110, people: 60, medianSeconds: 250, totalSeconds: 61 * 3600 },
    priorTime: { sessions: 100, people: 60, medianSeconds: 212, totalSeconds: 50 * 3600 },
  };
  const byKey = (tiles: ReturnType<typeof usageTiles>) => Object.fromEntries(tiles.map((t) => [t.key, t]));

  test("the four tiles read as the mock does", () => {
    const t = byKey(usageTiles(ready));
    expect(t.ctx).toEqual({
      key: "ctx",
      label: "context.lc visits",
      value: "1240",
      detail: "530 visitors · ",
      delta: { text: "+12%", good: true },
    });
    expect(t.tex?.value).toBe("860");
    expect(t.tex?.delta).toEqual({ text: "+31%", good: true });
    expect(t.session).toEqual({
      key: "session",
      label: "Typical session",
      value: "4m 10s",
      detail: " · active time",
      delta: { text: "+38s", good: true },
    });
    expect(t.hours).toEqual({
      key: "hours",
      label: "Hours in the app",
      value: "61",
      detail: "1.8 sessions a person",
    });
  });

  test("a site change that fell is bad when visits are the good direction", () => {
    const fell: AnalyticsLike = { ...ready, sites: [{ host: "context.lc", visits: 100, visitors: 5, priorVisits: 200 }] };
    expect(byKey(usageTiles(fell)).ctx?.delta).toEqual({ text: "-50%", good: false });
  });

  test("a site with no prior visits has no delta", () => {
    const fresh: AnalyticsLike = { ...ready, sites: [{ host: "tex.lc", visits: 5, visitors: 2, priorVisits: 0 }] };
    expect(byKey(usageTiles(fresh)).tex?.delta).toBeUndefined();
  });

  test("a session that got shorter reads as a negative change", () => {
    const shorter: AnalyticsLike = { ...ready, time: { ...ready.time!, medianSeconds: 200 }, priorTime: { ...ready.priorTime!, medianSeconds: 212 } };
    expect(byKey(usageTiles(shorter)).session?.delta).toEqual({ text: "-12s", good: false });
  });

  test("without analytics every tile is an em dash", () => {
    for (const a of [undefined, { connected: false } as AnalyticsLike, { connected: true, error: "down" } as AnalyticsLike]) {
      const t = usageTiles(a);
      expect(t.map((x) => x.value)).toEqual(["—", "—", "—", "—"]);
      expect(t.every((x) => x.delta === undefined)).toBe(true);
    }
  });

  test("a missing site on a ready answer reads an em dash", () => {
    const t = byKey(usageTiles({ ...ready, sites: [] }));
    expect(t.ctx).toEqual({ key: "ctx", label: "context.lc visits", value: "—", detail: "" });
  });

  test("hours and sessions need people to divide by", () => {
    const none: AnalyticsLike = { ...ready, time: { sessions: 3, people: 0, medianSeconds: 60, totalSeconds: 3600 } };
    expect(byKey(usageTiles(none)).hours?.detail).toBe("");
  });

  test("no prior time means no session delta", () => {
    expect(byKey(usageTiles({ ...ready, priorTime: null })).session?.delta).toBeUndefined();
  });
});

describe("analyticsNote", () => {
  test("is null while loading and when PostHog answered", () => {
    expect(analyticsNote(undefined)).toBeNull();
    expect(analyticsNote({ connected: true, error: null, sites: [], time: null, priorTime: null })).toBeNull();
  });

  test("says PostHog is not connected in our words", () => {
    expect(analyticsNote({ connected: false })).toBe("PostHog is not connected on this deployment.");
  });

  test("shows the error when it is connected but failed", () => {
    expect(analyticsNote({ connected: true, error: "rate limited" })).toBe("rate limited");
  });
});

describe("eventRows", () => {
  const series = (metric: string, counts: number[], total: number): Series => ({
    metric,
    total,
    points: counts.map((count, i) => ({ day: `2026-11-${String(i + 1).padStart(2, "0")}`, count })),
  });

  test("one row per counter, in the mock's order", () => {
    expect(eventRows([], null).map((r) => r.label)).toEqual([
      "Tool calls",
      "Searches",
      "Notes written",
      "Notes created",
      "AI client connections",
      "App sessions",
      "Sign-ins",
    ]);
  });

  test("today against yesterday is the percentage change of the last two points", () => {
    const [row] = eventRows([series("mcp.tool_call", [90, 100, 110], 4120)], null);
    expect(row).toMatchObject({ label: "Tool calls", total: 4120, change: { text: "+10%", good: true } });
  });

  test("a fall today is a negative change", () => {
    const [row] = eventRows([series("mcp.tool_call", [100, 89], 189)], null);
    expect(row?.change).toEqual({ text: "-11%", good: false });
  });

  test("today against yesterday is null when yesterday was zero", () => {
    const [row] = eventRows([series("mcp.tool_call", [0, 5], 5)], null);
    expect(row?.change).toBeNull();
  });

  test("a single point has no yesterday, so no change", () => {
    const [row] = eventRows([series("mcp.tool_call", [7], 7)], null);
    expect(row?.change).toBeNull();
  });

  test("the trend is the last fourteen days at most", () => {
    const counts = Array.from({ length: 20 }, (_, i) => i + 1);
    const [row] = eventRows([series("mcp.tool_call", counts, 210)], null);
    expect(row?.trend).toHaveLength(14);
    expect(row?.trend).toEqual(counts.slice(-14));
    expect(row?.trend[0]).toBe(7);
  });

  test("a short trend is kept whole", () => {
    const [row] = eventRows([series("mcp.tool_call", [1, 2, 3], 6)], null);
    expect(row?.trend).toEqual([1, 2, 3]);
  });

  test("a counter with no series reads zero with no trend and no change", () => {
    const row = eventRows([], null).find((r) => r.label === "Searches");
    expect(row).toEqual({ label: "Searches", total: 0, trend: [], change: null });
  });

  test("notes created comes from the workspace counts, not the usage series", () => {
    const rows = eventRows([series("note.write", [1], 1)], { total: 214, points: [10, 12, 15] });
    const notes = rows.find((r) => r.label === "Notes created");
    expect(notes?.total).toBe(214);
    expect(notes?.trend).toEqual([10, 12, 15]);
    expect(notes?.change).toEqual({ text: "+25%", good: true });
  });

  test("notes created with no workspace counts reads zero", () => {
    const notes = eventRows([], null).find((r) => r.label === "Notes created");
    expect(notes).toEqual({ label: "Notes created", total: 0, trend: [], change: null });
  });
});

describe("journeys", () => {
  test("nothing without a ready analytics answer", () => {
    expect(journeys(undefined)).toEqual([]);
    expect(journeys({ connected: false })).toEqual([]);
  });

  test("a funnel missing from the answer is skipped, the rest are kept", () => {
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [
        {
          id: "context_signin",
          steps: [
            { key: "code_sent", people: 140 },
            { key: "code_submitted", people: 121 },
            { key: "signed_in", people: 109 },
          ],
        },
      ],
    };
    const got = journeys(a);
    expect(got.map((j) => j.id)).toEqual(["context_signin"]);
    expect(got[0]?.title).toBe("Context sign-in");
  });

  test("no funnels on the answer skips them all", () => {
    expect(journeys({ connected: true, error: null, sites: [], time: null, priorTime: null })).toEqual([]);
  });

  test("steps are labelled, shares are of the first step, and a missing step counts zero", () => {
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [
        {
          id: "context_signin",
          steps: [
            { key: "code_sent", people: 140 },
            { key: "code_submitted", people: 121 },
          ],
        },
      ],
    };
    const [j] = journeys(a);
    expect(j?.steps.map((s) => [s.label, s.people, s.pct])).toEqual([
      ["Code requested", 140, 100],
      ["Code submitted", 121, 86],
      ["Signed in", 0, 0],
    ]);
    expect(j?.steps[1]?.width).toBeCloseTo((121 / 140) * 100, 10);
  });

  test("a first step of zero leaves every share at zero", () => {
    const a: AnalyticsLike = {
      connected: true,
      error: null,
      sites: [],
      time: null,
      priorTime: null,
      funnels: [{ id: "tex_handoff", steps: [{ key: "signed_in", people: 0 }, { key: "text_page", people: 4 }] }],
    };
    const [j] = journeys(a);
    expect(j?.steps.map((s) => [s.pct, s.width])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
  });
});

describe("ago", () => {
  test("null is never", () => {
    expect(ago(null, NOW)).toBe("never");
  });

  test("under a minute is just now, and so is a time in the future", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(NOW - 59_000, NOW)).toBe("just now");
    expect(ago(NOW + 5_000, NOW)).toBe("just now");
  });

  test("minutes, hours and days, rounding down", () => {
    expect(ago(NOW - 60_000, NOW)).toBe("1m ago");
    expect(ago(NOW - 120_000, NOW)).toBe("2m ago");
    expect(ago(NOW - 3_599_000, NOW)).toBe("59m ago");
    expect(ago(NOW - 3_600_000, NOW)).toBe("1h ago");
    expect(ago(NOW - 86_399_000, NOW)).toBe("23h ago");
    expect(ago(NOW - 86_400_000, NOW)).toBe("1d ago");
    expect(ago(NOW - 4 * DAY, NOW)).toBe("4d ago");
  });
});

describe("clientRows", () => {
  const client = (clientId: string, active: number, accounts: number, lastUsedAt: number | null): ClientLike => ({
    clientId,
    clientName: clientId,
    active,
    accounts,
    lastUsedAt,
  });

  test("drops clients with no active grants", () => {
    const rows = clientRows([client("gone", 0, 3, NOW), client("live", 2, 1, NOW)], NOW);
    expect(rows.map((r) => r.key)).toEqual(["live"]);
  });

  test("a client with only revoked grants is gone altogether", () => {
    expect(clientRows([client("a", 0, 1, null), client("b", 0, 0, null)], NOW)).toEqual([]);
  });

  test("sorts by active grants, then by last use, and maps the columns", () => {
    const rows = clientRows(
      [
        client("Cursor", 2, 1, NOW - 4 * DAY),
        client("Codex", 3, 2, NOW - DAY),
        client("ChatGPT", 6, 4, NOW - 3_600_000),
        client("Claude", 14, 8, NOW - 120_000),
        client("Tie-old", 3, 1, NOW - 10 * DAY),
        client("Tie-never", 3, 1, null),
      ],
      NOW,
    );
    expect(rows.map((r) => r.name)).toEqual(["Claude", "ChatGPT", "Codex", "Tie-old", "Tie-never", "Cursor"]);
    expect(rows[0]).toEqual({ key: "Claude", name: "Claude", grants: 14, people: 8, last: "2m ago" });
    expect(rows[1]?.last).toBe("1h ago");
    expect(rows[4]?.last).toBe("never");
    expect(rows[5]?.last).toBe("4d ago");
  });
});

describe("captureRows", () => {
  test("the three rows read as the mock does", () => {
    expect(
      captureRows({
        googleAccounts: 6,
        gmail: 5,
        calendar: 6,
        chat: 1,
        mailOpen: 1,
        mailAllowlisted: 4,
        obsidian: 2,
        mailOpenSlugs: ["samw"],
      }),
    ).toEqual([
      { k: "Google accounts", v: "6 · mail 5 · calendar 6 · chat 1", pills: [] },
      { k: "Mail capture", v: "4 allowlisted · 1 open to anyone", pills: ["@samw"] },
      { k: "Obsidian plugin", v: "2 workspaces", pills: [] },
    ]);
  });

  test("one Obsidian workspace reads singular, none reads plural", () => {
    const base = { googleAccounts: 0, gmail: 0, calendar: 0, chat: 0, mailOpen: 0, mailAllowlisted: 0 };
    expect(captureRows({ ...base, obsidian: 1 })[2]?.v).toBe("1 workspace");
    expect(captureRows({ ...base, obsidian: 0 })[2]?.v).toBe("0 workspaces");
  });

  test("no open mail inbox means no pills", () => {
    const rows = captureRows({
      googleAccounts: 1,
      gmail: 1,
      calendar: 1,
      chat: 0,
      mailOpen: 0,
      mailAllowlisted: 2,
      obsidian: 0,
    });
    expect(rows[1]).toEqual({ k: "Mail capture", v: "2 allowlisted · 0 open to anyone", pills: [] });
  });
});
