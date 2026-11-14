import { afterEach, describe, expect, test, vi } from "vitest";
import { internal, api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { AGAIN_WINDOW_MS, OPEN_WINDOW_MS, SEARCH_PAIR_RETENTION_MS } from "../functions/searchTimings";
import {
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  gatewayPost,
  setupTest,
} from "./fixtures.helpers";

/**
 * THE SEARCH QUALITY LOG, WRITE SIDE: the app's open and re-search by row id,
 * the gateway's first open and "again" by HMAC, and the sweep that clears the
 * pairing data 15 minutes after a search.
 *
 * Convex never hashes. Every actor and hit below is a 16-hex string standing in
 * for the HMAC the gateway would have computed under a key Convex does not hold.
 */

const MINUTE = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

async function world() {
  const t = setupTest();
  const ada = await createUser(t, "ada@example.invalid");
  const bo = await createUser(t, "bo@example.invalid");
  const workspaceId = await createWorkspace(t, ada, "ada-context");
  return { t, ada, bo, workspaceId };
}

async function rows(t: TestConvex) {
  return await t.run((ctx) => ctx.db.query("searchTimings").order("asc").collect());
}

/** A gateway quality row written straight into the table, at a time the test chooses. */
async function seedRow(
  t: TestConvex,
  row: {
    workspaceId: Id<"workspaces">;
    who: "ai" | "tex";
    actor: string;
    at: number;
    hits?: string[];
    opened?: number;
    again?: boolean;
  },
) {
  await t.run((ctx) =>
    ctx.db.insert("searchTimings", {
      workspaceId: row.workspaceId,
      surface: "ai",
      answeredBy: "index",
      found: true,
      ms: 100,
      at: row.at,
      who: row.who,
      actor: row.actor,
      pairUntil: row.at + SEARCH_PAIR_RETENTION_MS,
      ...(row.hits === undefined ? {} : { hits: row.hits }),
      ...(row.opened === undefined ? {} : { opened: row.opened }),
      ...(row.again === undefined ? {} : { again: row.again }),
    }),
  );
}

/** A 16-hex id, as the gateway's HMACs look: distinct for each `n`. */
const hex = (n: number) => n.toString(16).padStart(16, "0");
const HITS = [hex(1), hex(2), hex(3)];
const ACTOR = "aaaaaaaaaaaaaaaa";
const OTHER_ACTOR = "bbbbbbbbbbbbbbbb";

function timing(workspaceId: Id<"workspaces">, extra: Record<string, unknown> = {}) {
  return { workspaceId, answeredBy: "index", found: true, ms: 50, who: "ai", actor: ACTOR, hits: HITS, ...extra };
}

/** The app's search, as its device reports it: the row id comes back. */
async function appSearch(t: TestConvex, user: Id<"users">, workspaceId: Id<"workspaces">, found = true) {
  const result = await asUser(t, user).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found });
  expect(result.ok).toBe(true);
  return result.row as Id<"searchTimings">;
}

describe("the gateway's again: the same searcher searching again within 60 s with nothing opened", () => {
  test("the earlier paired, unopened search is marked again when the same actor's next search lands", async () => {
    const { t, workspaceId } = await world();
    expect((await gatewayPost(t, "/gateway/search-timing", timing(workspaceId, { hits: [] }))).status).toBe(200);
    expect((await gatewayPost(t, "/gateway/search-timing", timing(workspaceId, { found: true, hits: HITS }))).status).toBe(200);
    const [first, second] = await rows(t);
    expect(first).toMatchObject({ who: "ai", actor: ACTOR, again: true });
    expect(second.again).toBeUndefined();
    expect(first.pairUntil).toBeGreaterThan(first.at);
    expect(second.workspaceId).toBe(workspaceId);
  });

  test("a search more than 60 s earlier is not marked again", async () => {
    const { t, workspaceId } = await world();
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: Date.now() - AGAIN_WINDOW_MS - 1000 });
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    const [old] = await rows(t);
    expect(old.again).toBeUndefined();
  });

  test("a search that was opened is not marked again", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: HITS[0] });
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    const [first, second] = await rows(t);
    expect(first).toMatchObject({ opened: 1 });
    expect(first.again).toBeUndefined();
    expect(second.again).toBeUndefined();
  });

  test("another actor's search within 60 s is not the same searcher", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId, { actor: ACTOR }));
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId, { actor: OTHER_ACTOR }));
    const [ada, bo] = await rows(t);
    expect(ada.again).toBeUndefined();
    expect(bo.again).toBeUndefined();
  });

  test("a row whose pairing has lapsed is not the search a new one is 'again' of", async () => {
    const { t, workspaceId } = await world();
    const now = Date.now();
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: now - SEARCH_PAIR_RETENTION_MS - 1000 });
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    const [lapsed, fresh] = await rows(t);
    expect(lapsed.again).toBeUndefined();
    expect(fresh.again).toBeUndefined();
  });
});

describe("markOpened: the first gateway result opened", () => {
  test("the position is the hit's place in the results", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: HITS[1] });
    const [row] = await rows(t);
    expect(row.opened).toBe(2);
  });

  test("first open only: a second open of the same search changes nothing", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: HITS[0] });
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: HITS[2] });
    const [row] = await rows(t);
    expect(row.opened).toBe(1);
  });

  test("a hit that is in no recent search, a malformed hash, or an unknown actor is a no-op and never throws", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: "ffffffffffffffff" });
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: "not a hash" });
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: OTHER_ACTOR, hit: HITS[0] });
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: "nope", hit: HITS[0] });
    const [row] = await rows(t);
    expect(row.opened).toBeUndefined();
  });

  test("a search older than 10 minutes is not opened by a late fetch", async () => {
    const { t, workspaceId } = await world();
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: Date.now() - OPEN_WINDOW_MS - MINUTE, hits: HITS });
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: HITS[0] });
    const [row] = await rows(t);
    expect(row.opened).toBeUndefined();
  });

  test("opens after 15 minutes do nothing: the pairing has gone, so nothing is matched", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 0, 0));
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 15, 0, 1));
    await t.mutation(internal.functions.searchTimings.markOpened, { actor: ACTOR, hit: HITS[0] });
    const [row] = await rows(t);
    expect(row.opened).toBeUndefined();
  });
});

describe("the gateway's HMAC hits match across workspaces", () => {
  test("a note read from workspace B matches a search recorded on workspace A, by its hit hash", async () => {
    const { t, ada, workspaceId: a } = await world();
    const b = await createWorkspace(t, ada, "ada-second");
    // The hit is the HMAC of the address the note is read by from the search's caller: `@ada-context/plan.md`.
    const hitElsewhere = hex(42);
    await gatewayPost(t, "/gateway/search-timing", timing(a, { hits: [hitElsewhere] }));
    const sent = await gatewayPost(t, "/gateway/search-open", { workspaceId: b, actor: ACTOR, hit: hitElsewhere });
    expect(await sent.json()).toEqual({ recorded: true });
    const [row] = await rows(t);
    expect(row.opened).toBe(1);
  });
});

describe("reportScreen: the app's row, paired on the device by its id", () => {
  test("returns the row's id, and writes a who-app row with no actor, hits or pairing", async () => {
    const { t, ada, workspaceId } = await world();
    const result = await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    expect(result.ok).toBe(true);
    const [row] = await rows(t);
    expect(result.row).toBe(row._id);
    expect(Object.keys(row).sort()).toEqual(["_creationTime", "_id", "at", "found", "ms", "surface", "who", "workspaceId"]);
    expect(row).toMatchObject({ who: "app", surface: "screen", workspaceId });
    expect(row.actor).toBeUndefined();
    expect(row.pairUntil).toBeUndefined();
  });

  test("somebody outside the workspace, or signed out, is refused with no row and nothing written", async () => {
    const { t, bo, workspaceId } = await world();
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 5, found: true })).toEqual({ ok: false, row: null });
    expect(await t.mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 5, found: true })).toEqual({ ok: false, row: null });
    expect(await rows(t)).toEqual([]);
  });
});

describe("reportOpen: the app's tap, by row", () => {
  test("the first open of the search the row names is its position; a second open changes nothing", async () => {
    const { t, ada, workspaceId } = await world();
    const row = await appSearch(t, ada, workspaceId);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row, position: 2 })).toBe(true);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row, position: 5 })).toBe(false);
    const [stored] = await rows(t);
    expect(stored.opened).toBe(2);
  });

  test("refused for a non-member of the row's workspace, and for somebody signed out", async () => {
    const { t, ada, bo, workspaceId } = await world();
    const row = await appSearch(t, ada, workspaceId);
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportOpen, { row, position: 1 })).toBe(false);
    expect(await t.mutation(api.functions.searchTimings.reportOpen, { row, position: 1 })).toBe(false);
    const [stored] = await rows(t);
    expect(stored.opened).toBeUndefined();
  });

  test("a member of a shared workspace may open a row of that workspace", async () => {
    const { t, ada, bo, workspaceId } = await world();
    await addMember(t, workspaceId, bo, "member", ada);
    const row = await appSearch(t, bo, workspaceId);
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportOpen, { row, position: 1 })).toBe(true);
  });

  test("an open after 10 minutes does nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 0, 0));
    const { t, ada, workspaceId } = await world();
    const row = await appSearch(t, ada, workspaceId);
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 10, 0, 1));
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row, position: 1 })).toBe(false);
    expect((await rows(t))[0].opened).toBeUndefined();
  });

  test("the position is clamped to 1..50", async () => {
    const { t, ada, workspaceId } = await world();
    const high = await appSearch(t, ada, workspaceId);
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row: high, position: 99 });
    const low = await appSearch(t, ada, workspaceId);
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row: low, position: 0 });
    const [first, second] = await rows(t);
    expect(first.opened).toBe(50);
    expect(second.opened).toBe(1);
  });

  test("a gateway row is never opened by the app", async () => {
    const { t, ada, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    const [gateway] = await rows(t);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row: gateway._id, position: 1 })).toBe(false);
  });
});

describe("reportAgain: the app's re-search, by row", () => {
  test("a search followed within 60 s by nothing opened is marked again, the same person's next search in any workspace", async () => {
    const { t, ada, workspaceId: a } = await world();
    const first = await appSearch(t, ada, a);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row: first })).toBe(true);
    const [row] = await rows(t);
    expect(row).toMatchObject({ workspaceId: a, again: true });
  });

  test("an opened search is not marked again, and a second mark changes nothing", async () => {
    const { t, ada, workspaceId } = await world();
    const opened = await appSearch(t, ada, workspaceId);
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row: opened, position: 1 });
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row: opened })).toBe(false);
    const unopened = await appSearch(t, ada, workspaceId);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row: unopened })).toBe(true);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row: unopened })).toBe(false);
  });

  test("a refined search leaves the quality counts and keeps its timing, and cannot then be opened or re-searched", async () => {
    const { t, ada, workspaceId } = await world();
    const typed = await appSearch(t, ada, workspaceId);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row: typed, refined: true })).toBe(true);
    const [row] = await rows(t);
    expect(row.who).toBeUndefined();
    expect(row.again).toBeUndefined();
    expect(row.pairUntil).toBeUndefined();
    expect(row).toMatchObject({ surface: "screen", workspaceId });
    expect(typeof row.ms).toBe("number");
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { row: typed, position: 1 })).toBe(false);
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row: typed })).toBe(false);
  });

  test("refused for a non-member, and after 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 0, 0));
    const { t, ada, bo, workspaceId } = await world();
    const row = await appSearch(t, ada, workspaceId);
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportAgain, { row })).toBe(false);
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 1, 0, 1));
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportAgain, { row })).toBe(false);
    expect((await rows(t))[0].again).toBeUndefined();
  });
});

describe("the gateway route: optional fields", () => {
  test("a malformed optional field is dropped and the row is still recorded", async () => {
    const { t, workspaceId } = await world();
    const sent = await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "fast", found: true, ms: 10, who: "a sentence", actor: "ABC", hits: ["zz"],
    });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ recorded: true });
    const [row] = await rows(t);
    expect(row).toMatchObject({ surface: "ai", answeredBy: "fast", found: true, ms: 10 });
    expect(row.who).toBeUndefined();
    expect(row.actor).toBeUndefined();
    expect(row.hits).toBeUndefined();
    expect(row.pairUntil).toBeUndefined();
  });

  test("a who without a valid actor is dropped, since the row could never be opened", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", { workspaceId, answeredBy: "fast", found: true, ms: 10, who: "tex", actor: "xyz" });
    const [row] = await rows(t);
    expect(row.who).toBeUndefined();
    expect(row.actor).toBeUndefined();
  });

  test("hits are dropped whole when there are more than ten or one is not a hash", async () => {
    const { t, workspaceId } = await world();
    const eleven = Array.from({ length: 11 }, (_, i) => hex(100 + i));
    await gatewayPost(t, "/gateway/search-timing", { workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: eleven });
    await gatewayPost(t, "/gateway/search-timing", { workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: [HITS[0], "Not-Hex-Value!!"] });
    const written = await rows(t);
    expect(written.map((row) => row.hits)).toEqual([undefined, undefined]);
    expect(written.map((row) => row.who)).toEqual(["ai", "ai"]);
  });

  test("ten well-formed hits are kept, in order, with the pairing expiry set", async () => {
    const { t, workspaceId } = await world();
    const ten = Array.from({ length: 10 }, (_, i) => hex(200 + i));
    await gatewayPost(t, "/gateway/search-timing", { workspaceId, answeredBy: "index", found: true, ms: 10, who: "tex", actor: ACTOR, hits: ten });
    const [row] = await rows(t);
    expect(row).toMatchObject({ who: "tex", hits: ten });
    expect(row.pairUntil).toBe(row.at + SEARCH_PAIR_RETENTION_MS);
  });

  test("surface app is stored as an app row with no who, actor, hits or pairing", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId, { surface: "app" }));
    const [row] = await rows(t);
    expect(row.surface).toBe("app");
    expect(row.who).toBeUndefined();
    expect(row.actor).toBeUndefined();
    expect(row.hits).toBeUndefined();
    expect(row.pairUntil).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(["_creationTime", "_id", "answeredBy", "at", "found", "ms", "surface", "workspaceId"]);
  });
});

describe("POST /gateway/search-open", () => {
  test("marks the open of the hit it names, with the same auth as search-timing", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    const sent = await gatewayPost(t, "/gateway/search-open", { workspaceId, actor: ACTOR, hit: HITS[2] });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ recorded: true });
    const [row] = await rows(t);
    expect(row.opened).toBe(3);
  });

  test("a malformed body is answered 200 and changes nothing", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    for (const body of [
      { workspaceId, actor: ACTOR, hit: "a sentence somebody typed" },
      { workspaceId, actor: "short", hit: HITS[0] },
      { actor: ACTOR, hit: HITS[0] },
    ]) {
      const sent = await gatewayPost(t, "/gateway/search-open", body);
      expect(sent.status).toBe(200);
      expect(await sent.json()).toEqual({ recorded: false });
    }
    expect((await rows(t))[0].opened).toBeUndefined();
  });

  test("without the gateway's secret, nothing is marked", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", timing(workspaceId));
    const none = await gatewayPost(t, "/gateway/search-open", { workspaceId, actor: ACTOR, hit: HITS[0] }, { secret: null });
    expect(none.status).not.toBe(200);
    expect((await rows(t))[0].opened).toBeUndefined();
  });
});

describe("the sweep clears pairing data once it lapses", () => {
  test("lapsed actor and hits are removed; live pairing and every other field are kept", async () => {
    const { t, workspaceId } = await world();
    const now = Date.now();
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: now - SEARCH_PAIR_RETENTION_MS - MINUTE, hits: HITS, again: true });
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: now - 5 * MINUTE, hits: HITS });
    await t.mutation(internal.functions.searchTimings.purgeOldSearchTimings, {});
    const [old, recent] = await rows(t);
    expect(old.hits).toBeUndefined();
    expect(old.actor).toBeUndefined();
    expect(old.pairUntil).toBeUndefined();
    expect(old).toMatchObject({ who: "ai", again: true, surface: "ai" });
    expect(recent).toMatchObject({ actor: ACTOR, hits: HITS });
  });

  test("a backlog of more than 2,000 lapsed rows empties, in a chain of sweeps", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    vi.setSystemTime(Date.UTC(2026, 10, 14, 9, 0, 0));
    const { t, workspaceId } = await world();
    const past = Date.now() - SEARCH_PAIR_RETENTION_MS - MINUTE;
    await t.run(async (ctx) => {
      for (let i = 0; i < 2_100; i++) {
        await ctx.db.insert("searchTimings", {
          workspaceId, surface: "ai", answeredBy: "index", found: true, ms: 1, at: past,
          who: "ai", actor: ACTOR, hits: HITS, pairUntil: past + SEARCH_PAIR_RETENTION_MS,
        });
      }
    });
    await t.mutation(internal.functions.searchTimings.purgeOldSearchTimings, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run((ctx) =>
      ctx.db.query("searchTimings").withIndex("by_pairUntil", (q) => q.gt("pairUntil", 0).lt("pairUntil", Date.now())).collect(),
    );
    expect(left).toEqual([]);
    const all = await rows(t);
    expect(all).toHaveLength(2_100);
    expect(all.every((row) => row.actor === undefined && row.hits === undefined && row.who === "ai")).toBe(true);
  });
});

describe("the one-time scrub of rows written before pairUntil existed", () => {
  test("a legacy row's actor and hits are cleared; a row with live pairing, and every other field, is kept", async () => {
    const { t, workspaceId } = await world();
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("searchTimings", {
        workspaceId, surface: "ai", answeredBy: "index", found: true, ms: 1, at: now - 2 * SEARCH_PAIR_RETENTION_MS,
        who: "ai", actor: ACTOR, hits: HITS, opened: 2,
      }),
    );
    await seedRow(t, { workspaceId, who: "ai", actor: OTHER_ACTOR, at: now - MINUTE, hits: HITS });
    await t.mutation(internal.functions.searchTimings.scrubLegacyPairing, { cursor: null });
    const [legacy, live] = await rows(t);
    expect(legacy).toMatchObject({ who: "ai", opened: 2, surface: "ai" });
    expect(legacy.actor).toBeUndefined();
    expect(legacy.hits).toBeUndefined();
    expect(live).toMatchObject({ actor: OTHER_ACTOR, hits: HITS });
  });
});
