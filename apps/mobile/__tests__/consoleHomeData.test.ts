/**
 * The console's Home page as data (`features/admin/console/pages/homeData.ts`), in the staff console mock's
 * wording (`staff-console.html`). Pure functions: no React, no native modules.
 */

import { describe, expect, test } from "@jest/globals";
import {
  DAY_MS,
  STATS_MAX_DAYS,
  delta,
  costsLikeOf,
  homeTiles,
  knownPerText,
  knownSpend,
  money,
  needsList,
  percentChange,
  plural,
  statsWindows,
  windowRange,
  type CostsLike,
  type NeedsSources,
  type TexStatsLike,
} from "../features/admin/console/pages/homeData";

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
    people: { one: 6, group: 4, any: 9 },
    texts: { inOne: 1000, inGroup: 234, outOne: 0, outGroup: 0 },
    cost: { totalUsd: 4.7 },
    costPerTextUsd: 0.16,
    notes: { created: 12 },
    series: [
      { at: 1, people: 2, textsIn: 5, usd: 0.5, notesCreated: 1 },
      { at: 2, people: 3, textsIn: 0, usd: 0, notesCreated: 0 },
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
    const withCounts: TexStatsLike = { ...stats, people: { one: 8, group: 4, any: 12 } };
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

  test("guests are everyone who texted minus those with accounts, on the same id space", () => {
    const t = byKey(homeTiles({ d: "7", stats, costs, accounts: 14, answered: null })).texters;
    expect(t.detail).toBe("6 with accounts · 3 guests");
  });

  test("guests never go negative when the one-to-one count is ahead of the total", () => {
    const odd: TexStatsLike = { ...stats, people: { one: 6, group: 4, any: 2 } };
    const t = byKey(homeTiles({ d: "7", stats: odd, costs, accounts: 14, answered: null })).texters;
    expect(t.detail).toBe("6 with accounts · 0 guests");
  });

  test("the sparklines read the per-day series fields", () => {
    const t = byKey(homeTiles({ d: "7", stats, costs, accounts: 14, answered: null }));
    expect(t.dap.spark).toEqual([2, 3]);
    expect(t.texters.spark).toEqual([2, 3]);
    expect(t.cpt.spark).toEqual([0.1, 0]);
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
    mailOpen: [{ slug: "samw", ownerId: "user_samw" }],
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
      target: { page: "people", x: "user_samw" },
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
    const list = needsList({
      ...none,
      mailOpen: [
        { slug: "samw", ownerId: "user_samw" },
        { slug: "crystal", ownerId: "user_crystal" },
      ],
    });
    expect(list.map((n) => n.key)).toEqual(["mail-samw", "mail-crystal"]);
    expect(list.map((n) => n.target)).toEqual([
      { page: "people", x: "user_samw" },
      { page: "people", x: "user_crystal" },
    ]);
  });
});

// -- statsWindows, known costs, the partial-window tiles (review of #3291) ----------------------------------------------

describe("statsWindows", () => {
  test("the gateway keeps sixty days, and the constant says so", () => {
    expect(STATS_MAX_DAYS).toBe(60);
  });

  test("a 90-day window is cut to the sixty days kept and says it is partial, with no prior window", () => {
    const w = statsWindows("90", NOW);
    expect(w).toEqual({ from: NOW - 60 * DAY, to: NOW, partial: true, prior: null });
  });

  test("a 30-day window is whole, and its prior window reaches exactly sixty days back, which is still kept", () => {
    // The edge is inclusive: `priorFrom >= earliest`. Pinned as the code has it, so a change of edge shows up here.
    const w = statsWindows("30", NOW);
    expect(w.from).toBe(NOW - 30 * DAY);
    expect(w.to).toBe(NOW);
    expect(w.partial).toBe(false);
    expect(w.prior).toEqual({ from: NOW - 60 * DAY, to: NOW - 30 * DAY });
  });

  test("a 7-day window's prior window is the seven days before it", () => {
    expect(statsWindows("7", NOW)).toEqual({
      from: NOW - 7 * DAY,
      to: NOW,
      partial: false,
      prior: { from: NOW - 14 * DAY, to: NOW - 7 * DAY },
    });
  });

  test("a 1-day window has a prior window", () => {
    const w = statsWindows("1", NOW);
    expect(w.partial).toBe(false);
    expect(w.prior).toEqual({ from: NOW - 2 * DAY, to: NOW - DAY });
  });

  test("a 7-day window is never cut by the gateway's limit", () => {
    expect(statsWindows("7", NOW).from).toBeGreaterThan(NOW - STATS_MAX_DAYS * DAY);
  });
});

describe("knownPerText and knownSpend", () => {
  const base: TexStatsLike = {
    configured: true,
    dailyActive: 1,
    people: { one: 1, group: 0, any: 1 },
    texts: { inOne: 0, inGroup: 0, outOne: 0, outGroup: 0 },
    cost: { totalUsd: 0 },
    costPerTextUsd: null,
    notes: { created: 0 },
    series: [],
  };

  test("no stats means no known figure", () => {
    expect(knownPerText(null)).toBeNull();
    expect(knownPerText(undefined)).toBeNull();
    expect(knownSpend(null)).toBeNull();
    expect(knownSpend(undefined)).toBeNull();
  });

  test("texts with a known cost give the cost per text and the spend", () => {
    const s: TexStatsLike = { ...base, texts: { inOne: 10, inGroup: 5, outOne: 0, outGroup: 0 }, cost: { totalUsd: 3 }, costPerTextUsd: 0.2 };
    expect(knownPerText(s)).toBe(0.2);
    expect(knownSpend(s)).toBe(3);
  });

  test("texts with zero cost are unknown, never free: both read null", () => {
    const s: TexStatsLike = { ...base, texts: { inOne: 10, inGroup: 0, outOne: 0, outGroup: 0 }, cost: { totalUsd: 0 }, costPerTextUsd: 0 };
    expect(knownPerText(s)).toBeNull();
    expect(knownSpend(s)).toBeNull();
  });

  test("group texts count as texts too: zero cost with only group texts is still unknown", () => {
    const s: TexStatsLike = { ...base, texts: { inOne: 0, inGroup: 4, outOne: 0, outGroup: 0 }, cost: { totalUsd: 0 }, costPerTextUsd: 0 };
    expect(knownPerText(s)).toBeNull();
    expect(knownSpend(s)).toBeNull();
  });

  test("no texts and a zero cost is a true zero, not unknown", () => {
    const free: TexStatsLike = { ...base, costPerTextUsd: 0 };
    expect(knownPerText(free)).toBe(0);
    expect(knownSpend(free)).toBe(0);
  });
});

describe("homeTiles with unknown costs and partial windows", () => {
  const byKey = (tiles: ReturnType<typeof homeTiles>) => Object.fromEntries(tiles.map((t) => [t.key, t]));
  const base: TexStatsLike = {
    configured: true,
    dailyActive: 2,
    people: { one: 2, group: 1, any: 4 },
    texts: { inOne: 4, inGroup: 0, outOne: 0, outGroup: 0 },
    cost: { totalUsd: 0 },
    costPerTextUsd: 0,
    notes: { created: 0 },
    series: [{ at: 1, people: 1, textsIn: 2, usd: 0, notesCreated: 0 }],
  };

  test("texts with zero cost: cost per text reads an em dash and no delta, even with a prior to compare", () => {
    const t = byKey(homeTiles({ d: "7", stats: base, costs: null, accounts: 3, answered: null, priorPerText: 0.19 }));
    expect(t.cpt.value).toBe("—");
    expect(t.cpt.delta).toBeUndefined();
  });

  test("texts with zero cost: spent on AI reads an em dash, not $0.00", () => {
    const t = byKey(homeTiles({ d: "7", stats: base, costs: null, accounts: 3, answered: null }));
    expect(t.spent.value).toBe("—");
    expect(t.spent.detail).toBe("");
  });

  test("zero texts and zero cost: cost per text and spend read $0.00", () => {
    const quiet: TexStatsLike = { ...base, texts: { inOne: 0, inGroup: 0, outOne: 0, outGroup: 0 } };
    const t = byKey(homeTiles({ d: "7", stats: quiet, costs: null, accounts: 3, answered: null }));
    expect(t.cpt.value).toBe("$0.00");
    expect(t.spent.value).toBe("$0.00");
  });

  test("a whole window adds no 'last 60 days' to any tile", () => {
    const tiles = homeTiles({ d: "30", stats: base, costs: null, accounts: 3, answered: 4, partial: false });
    for (const t of tiles) expect(t.detail).not.toContain("last 60 days");
  });

  test("a partial window says 'last 60 days' on the tiles that read the stats", () => {
    const t = byKey(homeTiles({ d: "90", stats: base, costs: null, accounts: 3, answered: 4, partial: true }));
    expect(t.dap.detail).toContain("last 60 days");
    expect(t.texters.detail).toBe("2 with accounts · 2 guests · last 60 days");
    expect(t.texts.detail).toContain("last 60 days");
    expect(t.cpt.detail).toContain("last 60 days");
  });

  test("a partial window with costs given says it on the stats tiles only; the spend line keeps its own detail", () => {
    const costs: CostsLike = { totalUsd: 9, outOfPocketUsd: 1, perTextUsd: 0.5, priorPerTextUsd: null };
    const t = byKey(homeTiles({ d: "90", stats: base, costs, accounts: 3, answered: null, partial: true }));
    expect(t.spent.detail).toBe("$1.00 of it out of pocket");
    expect(t.texters.detail).toContain("last 60 days");
  });

  test("without costs, spent on AI says 'last 60 days' as its detail only when the window is partial", () => {
    const partial = byKey(homeTiles({ d: "90", stats: base, costs: null, accounts: 3, answered: null, partial: true }));
    expect(partial.spent.detail).toBe("last 60 days");
    const whole = byKey(homeTiles({ d: "30", stats: base, costs: null, accounts: 3, answered: null, partial: false }));
    expect(whole.spent.detail).toBe("");
  });
});

describe("costsLikeOf", () => {
  const live = {
    configured: true,
    error: null,
    totalUsd: 37.66,
    outOfPocketUsd: 9,
    outOfPocketPeopleUsd: 6.5,
    perTextUsd: 0.16,
    priorPerTextUsd: 0.19,
    daily: [{ byFeature: [{ usd: 1 }, { usd: 2.5 }] }, { byFeature: [] }],
  };
  test("reads people's spend, the lab-free out of pocket and each day's total", () => {
    expect(costsLikeOf(live)).toEqual({ totalUsd: 37.66, outOfPocketUsd: 6.5, perTextUsd: 0.16, priorPerTextUsd: 0.19, daily: [{ usd: 3.5 }, { usd: 0 }] });
  });
  test("is null while loading, unconfigured or failed, so Home falls back to texStats", () => {
    expect(costsLikeOf(undefined)).toBeNull();
    expect(costsLikeOf({ configured: false })).toBeNull();
    expect(costsLikeOf({ error: "Couldn't load costs" })).toBeNull();
  });
  test("gives Home the out-of-pocket line and no change line without a like-for-like window", () => {
    const tiles = homeTiles({ d: "7", stats: null, costs: costsLikeOf({ ...live, priorPerTextUsd: null }), accounts: null, answered: null });
    const spent = tiles.find((t) => t.key === "spent")!;
    const cpt = tiles.find((t) => t.key === "cpt")!;
    expect(spent.detail).toBe("$6.50 of it out of pocket");
    expect(cpt.value).toBe("$0.16");
    expect(cpt.delta).toBeUndefined();
  });
});
