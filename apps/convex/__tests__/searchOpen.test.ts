import { describe, expect, test } from "vitest";
import { internal, api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { SEARCH_HITS_RETENTION_MS } from "../functions/searchTimings";
import { actorFor, hitFor } from "../functions/lib/searchTimingIds";
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
 * THE SEARCH QUALITY LOG, WRITE SIDE: the "again" flag, the first open of a
 * search's results, the gateway's optional fields, and the sweep that clears
 * the hashes of hits after 15 minutes.
 *
 * Every row here is opaque: a 16-hex actor and 16-hex hit hashes. The tests
 * assert the exact field set and that no query, path or title can be stored.
 */

const MINUTE = 60_000;

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

/** A quality row written straight into the table, at a time the test chooses. */
async function seedRow(
  t: TestConvex,
  row: {
    workspaceId: Id<"workspaces">;
    who: "app" | "ai" | "tex";
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
      surface: row.who === "app" ? "screen" : "ai",
      found: true,
      ms: 100,
      at: row.at,
      who: row.who,
      actor: row.actor,
      ...(row.hits === undefined ? {} : { hits: row.hits }),
      ...(row.opened === undefined ? {} : { opened: row.opened }),
      ...(row.again === undefined ? {} : { again: row.again }),
      ...(row.who === "app" ? {} : { answeredBy: "index" as const }),
    }),
  );
}

const HITS = ["0000000000000001", "0000000000000002", "0000000000000003"];
const ACTOR = "aaaaaaaaaaaaaaaa";

describe("again: the same person searching again within 60 s with nothing opened", () => {
  test("the earlier unopened search is marked again when the same person's next search lands", async () => {
    const { t, ada, workspaceId } = await world();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 120, found: true });
    const [first, second] = await rows(t);
    expect(first.again).toBe(true);
    expect(second.again).toBeUndefined();
  });

  test("a search more than 60 s earlier is not marked again", async () => {
    const { t, ada, workspaceId } = await world();
    await seedRow(t, { workspaceId, who: "app", actor: await actorFor(ada), at: Date.now() - MINUTE - 1000 });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 120, found: true });
    const [old] = await rows(t);
    expect(old.again).toBeUndefined();
  });

  test("a search that was opened is not marked again", async () => {
    const { t, ada, workspaceId } = await world();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 1 });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 120, found: true });
    const [first] = await rows(t);
    expect(first).toMatchObject({ opened: 1 });
    expect(first.again).toBeUndefined();
  });

  test("another person's search within 60 s is not the same searcher", async () => {
    const { t, ada, bo, workspaceId } = await world();
    await addMember(t, workspaceId, bo, "member", ada);
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    await asUser(t, bo).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 120, found: true });
    const [ada1, bo1] = await rows(t);
    expect(ada1.again).toBeUndefined();
    expect(bo1.again).toBeUndefined();
  });

  test("a gateway search is marked again by the same actor's next gateway search", async () => {
    const { t, workspaceId } = await world();
    const body = { workspaceId, answeredBy: "index", found: false, ms: 50, who: "ai", actor: ACTOR, hits: [] };
    expect((await gatewayPost(t, "/gateway/search-timing", body)).status).toBe(200);
    expect((await gatewayPost(t, "/gateway/search-timing", { ...body, found: true, hits: HITS })).status).toBe(200);
    const [first, second] = await rows(t);
    expect(first).toMatchObject({ who: "ai", actor: ACTOR, again: true });
    expect(second.again).toBeUndefined();
  });
});

describe("markOpened: the first result opened", () => {
  test("by hit: the position is the hit's place in the results", async () => {
    const { t, workspaceId } = await world();
    const body = { workspaceId, answeredBy: "index", found: true, ms: 50, who: "ai", actor: ACTOR, hits: HITS };
    await gatewayPost(t, "/gateway/search-timing", body);
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: ACTOR, hit: HITS[1] });
    const [row] = await rows(t);
    expect(row.opened).toBe(2);
  });

  test("by position: the app's newest search takes the position reported", async () => {
    const { t, ada, workspaceId } = await world();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    expect(await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 4 })).toBe(true);
    const [row] = await rows(t);
    expect(row.opened).toBe(4);
  });

  test("first open only: a second open of the same search changes nothing", async () => {
    const { t, ada, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 50, who: "ai", actor: ACTOR, hits: HITS,
    });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: ACTOR, hit: HITS[0] });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: ACTOR, hit: HITS[2] });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 2 });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 5 });
    const [gateway, screen] = await rows(t);
    expect(gateway.opened).toBe(1);
    expect(screen.opened).toBe(2);
  });

  test("a hit that is in no recent search, a bad hash, or an unknown actor is a no-op and never throws", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 50, who: "ai", actor: ACTOR, hits: HITS,
    });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: ACTOR, hit: "ffffffffffffffff" });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: ACTOR, hit: "not a hash" });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: "bbbbbbbbbbbbbbbb", hit: HITS[0] });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: "nope", position: 3 });
    const [row] = await rows(t);
    expect(row.opened).toBeUndefined();
  });

  test("a search older than 10 minutes is not opened by a late fetch", async () => {
    const { t, workspaceId } = await world();
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: Date.now() - 11 * MINUTE, hits: HITS });
    await t.mutation(internal.functions.searchTimings.markOpened, { workspaceId, actor: ACTOR, hit: HITS[0] });
    const [row] = await rows(t);
    expect(row.opened).toBeUndefined();
  });
});

describe("the actor is the searcher, across workspaces", () => {
  test("a note opened in workspace B matches a search recorded on workspace A, by its hit hash", async () => {
    const { t, ada, workspaceId: a } = await world();
    const b = await createWorkspace(t, ada, "ada-second");
    // The hit is hashed with the workspace of its own result: the note lives in A.
    const hitInA = await hitFor(a, "1-projects/plan.md");
    const actor = await actorFor(ada);
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId: a, answeredBy: "index", found: true, ms: 10, who: "ai", actor, hits: [hitInA],
    });
    const sent = await gatewayPost(t, "/gateway/search-open", { workspaceId: b, actor, hit: hitInA });
    expect(await sent.json()).toEqual({ recorded: true });
    const [row] = await rows(t);
    expect(row.opened).toBe(1);
  });

  test("a second workspace's search is 'again' the first workspace's unopened search by the same person", async () => {
    const { t, ada, workspaceId: a } = await world();
    const b = await createWorkspace(t, ada, "ada-second");
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId: a, ms: 100, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId: b, ms: 120, found: true });
    const [first, second] = await rows(t);
    expect(first).toMatchObject({ workspaceId: a, again: true });
    expect(second.again).toBeUndefined();
  });
});

describe("reportOpen: the app's tap", () => {
  test("refused for a non-member and for somebody signed out, answering false and writing nothing", async () => {
    const { t, ada, bo, workspaceId } = await world();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    expect(await asUser(t, bo).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 1 })).toBe(false);
    expect(await t.mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 1 })).toBe(false);
    const [row] = await rows(t);
    expect(row.opened).toBeUndefined();
  });

  test("the position is clamped to 1..50", async () => {
    const { t, ada, workspaceId } = await world();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 99 });
    expect((await rows(t))[0].opened).toBe(50);
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    await asUser(t, ada).mutation(api.functions.searchTimings.reportOpen, { workspaceId, position: 0 });
    expect((await rows(t))[1].opened).toBe(1);
  });

  test("the app's screen row carries who and an actor derived from the user, never the user id", async () => {
    const { t, ada, workspaceId } = await world();
    await asUser(t, ada).mutation(api.functions.searchTimings.reportScreen, { workspaceId, ms: 100, found: true });
    const [row] = await rows(t);
    expect(row).toMatchObject({ who: "app", actor: await actorFor(ada) });
    expect(row.actor).toMatch(/^[0-9a-f]{16}$/);
    expect(row.actor).not.toContain(ada);
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
    const eleven = Array.from({ length: 11 }, (_, i) => hitFor(workspaceId, `note-${i}`));
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: await Promise.all(eleven),
    });
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: [HITS[0], "Not-Hex-Value!!"],
    });
    const written = await rows(t);
    expect(written.map((row) => row.hits)).toEqual([undefined, undefined]);
    expect(written.map((row) => row.who)).toEqual(["ai", "ai"]);
  });

  test("ten well-formed hits are kept, in order", async () => {
    const { t, workspaceId } = await world();
    const ten = await Promise.all(Array.from({ length: 10 }, (_, i) => hitFor(workspaceId, `note-${i}`)));
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "tex", actor: ACTOR, hits: ten,
    });
    const [row] = await rows(t);
    expect(row).toMatchObject({ who: "tex", hits: ten });
  });

  test("surface app is stored as an app row with no who, actor or hits", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, surface: "app", who: "ai", actor: ACTOR, hits: HITS,
    });
    const [row] = await rows(t);
    expect(row.surface).toBe("app");
    expect(row.who).toBeUndefined();
    expect(row.actor).toBeUndefined();
    expect(row.hits).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual(["_creationTime", "_id", "answeredBy", "at", "found", "ms", "surface", "workspaceId"]);
  });

  test("a tex row is stored as surface ai with who tex", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "tex", actor: ACTOR, hits: HITS,
    });
    const [row] = await rows(t);
    expect(row).toMatchObject({ surface: "ai", who: "tex", actor: ACTOR, hits: HITS });
  });
});

describe("POST /gateway/search-open", () => {
  test("marks the open of the hit it names, with the same auth as search-timing", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: HITS,
    });
    const sent = await gatewayPost(t, "/gateway/search-open", { workspaceId, actor: ACTOR, hit: HITS[2] });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ recorded: true });
    const [row] = await rows(t);
    expect(row.opened).toBe(3);
  });

  test("a malformed body is answered 200 and changes nothing", async () => {
    const { t, workspaceId } = await world();
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: HITS,
    });
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
    await gatewayPost(t, "/gateway/search-timing", {
      workspaceId, answeredBy: "index", found: true, ms: 10, who: "ai", actor: ACTOR, hits: HITS,
    });
    const none = await gatewayPost(t, "/gateway/search-open", { workspaceId, actor: ACTOR, hit: HITS[0] }, { secret: null });
    expect(none.status).not.toBe(200);
    expect((await rows(t))[0].opened).toBeUndefined();
  });
});

describe("the sweep clears hits after 15 minutes", () => {
  test("hits older than 15 minutes are removed; newer hits, and every other field, are kept", async () => {
    const { t, workspaceId } = await world();
    const now = Date.now();
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: now - SEARCH_HITS_RETENTION_MS - MINUTE, hits: HITS, again: true });
    await seedRow(t, { workspaceId, who: "ai", actor: ACTOR, at: now - 5 * MINUTE, hits: HITS });
    await t.mutation(internal.functions.searchTimings.purgeOldSearchTimings, {});
    const [old, recent] = await rows(t);
    expect(old.hits).toBeUndefined();
    expect(old).toMatchObject({ who: "ai", actor: ACTOR, again: true, surface: "ai" });
    expect(recent.hits).toEqual(HITS);
  });
});
