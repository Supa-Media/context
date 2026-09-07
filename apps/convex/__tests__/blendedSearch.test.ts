/**
 * SEARCHING SEVERAL CONTEXTS AT ONCE.
 *
 * The console's search page asks one question of every context a person can
 * reach. That is a new shape of request in this system and it brings a new
 * shape of risk with it: a single call that names a **list** of workspaces and
 * returns note paths, titles and body snippets out of several buckets, blended
 * into one list where nothing on screen says which one an answer came from
 * unless the server put it there.
 *
 * So this file asks two different kinds of question.
 *
 * ## The fusion, as arithmetic
 *
 * `lib/blendedSearch.ts` is pure and every rule in it is a decision somebody
 * could reasonably reverse: reciprocal-rank fusion rather than score
 * normalization, per-source cursor offsets rather than a global one, ties
 * broken deterministically. Each is asserted here rather than described,
 * because "one big context dominates the blend" is precisely the failure that
 * looks like a ranking opinion instead of a bug.
 *
 * ## The boundary, as an attack
 *
 * The interesting attacks on a fan-out are not "read another tenant's note".
 * They are subtler and each has a test below:
 *
 *  - **Name someone else's context in the scope list.** A hundred guesses fit
 *    in one request, so an endpoint that refused a real-but-forbidden id
 *    differently from an invented one is an oracle with a hundred times the
 *    throughput of the single-context endpoints `isolation.test.ts` guards.
 *  - **Name it in a crafted cursor.** A cursor is machinery the client is meant
 *    to treat as opaque, which makes it the obvious place to try to smuggle a
 *    workspace in. It must not be able to cause a bucket to be *touched* — so
 *    the assertion is over the other tenant's recorded requests, not over the
 *    response, because a response that omits what it read is still a read.
 *  - **Count what you cannot see.** A blended total assembled before the
 *    privacy filter would tell a team member how many private notes matched
 *    their word, in a system that is careful about that one subtraction
 *    everywhere else.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, counts **as measured** — one
 * measured zero included, because a record listing only the satisfying numbers
 * is decoration.
 *
 *   `resolveScope` returning `requested` mapped over the eligible list
 *     instead of intersecting with it                                        3
 *   `fuse` scoring by position on a per-source scale instead of by rank       2
 *   `decodeCursor` returning `at` unclamped                                   1
 *   `pageOf` advancing one global offset instead of one rank per source       1
 *   the fan-out hardcoding `scope: "private"` in place of
 *     `authorizeFileAccess`                                                   1
 *   `searchableFor` accepting any projection state rather than `ready`   0, then 1
 *
 * The last line is the one worth reading. It measured **zero** first time: the
 * fixture only ever built `ready` rows, so a guard that let a half-filled
 * database answer had nothing to trip over. The zero is what bought the
 * "a context still filling its index" test below, and the mutation reddens it
 * now. A backfilling projection answers a query about a note it has not copied
 * yet with a silence, and a blended list renders silence as "nothing here" —
 * which is the single sentence search must never say wrongly.
 *
 * The `scope: "private"` measurement of 1 is thin for how serious that mutation
 * is, and it is thin honestly: `resolveScope` already keeps a caller out of a
 * context they are not in, so the tier check is defence in depth and only the
 * team-tier test can see it move. The alternative — asserting it from several
 * angles — would be several tests measuring the same one thing.
 *
 * ## Sabotage record, second pass
 *
 * Measured over this file and `files.test.ts` together, adversarially rather
 * than by the author:
 *
 *   `searchNotes`' `isVisible` returning true for every path              4
 *   `resolveScope` mapping over `requested` instead of intersecting       4
 *   ...and the fan-out then skipping `authorizeFileAccess` as well        4,
 *     with the other tenant's bucket recording four reads it had not made
 *   `searchContexts` reading offset zero instead of the cursor's          1
 *   `searchableFor` accepting any projection state but `null`             1
 *   the blended total staying exact when a source failed                  1
 *
 * The third line is the one that mattered. It is what proves the recorded-
 * request assertion is load-bearing rather than decorative: with both the
 * scope filter and the authorization gone, the other tenant's bucket went from
 * thirteen requests to seventeen, which is the read a response-shaped
 * assertion cannot see. And the first line is the honest shape of "there is no
 * second privacy filter" — bypassing the one filter is enough to redden this,
 * because there is nowhere else the fan-out could have caught it.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  BLEND_PAGE_SIZE,
  MAX_SOURCE_DEPTH,
  decodeCursor,
  depthFor,
  encodeCursor,
  fuse,
  pageOf,
  queryFingerprint,
  resolveScope,
  type BlendSource,
} from "../functions/lib/blendedSearch";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

/* -------------------------------------------------------------------------- */
/*                            the fusion, as arithmetic                        */
/* -------------------------------------------------------------------------- */

/** A source whose hits are `<key>-0.md`, `<key>-1.md`, … in rank order. */
function source(key: string, count: number, offset = 0, asked = BLEND_PAGE_SIZE): BlendSource {
  return {
    key,
    hits: Array.from({ length: count }, (_, index) => ({
      path: `${key}-${index}.md`,
      title: `${key} ${index}`,
      snippets: [`about ${key}`],
    })),
    offset,
    asked,
  };
}

describe("blending several ranked lists", () => {
  test("a big context does not sweep the page", () => {
    // The failure this exists to stop: forty results from one context and one
    // from the other, because the big one's scores are bigger. Under rank
    // fusion each context contributes the same ladder, so the top of the page
    // alternates.
    const rows = fuse([source("big", 40), source("small", 3)]);
    const top = rows.slice(0, 6).map((row) => row.key);
    expect(top.filter((key) => key === "small").length).toBe(3);
    expect(top.filter((key) => key === "big").length).toBe(3);
  });

  test("a context's first result outranks any context's second", () => {
    const rows = fuse([source("a", 5), source("b", 5), source("c", 5)]);
    expect(rows.slice(0, 3).map((row) => row.rank)).toEqual([0, 0, 0]);
    expect(rows.slice(3, 6).map((row) => row.rank)).toEqual([1, 1, 1]);
  });

  test("ties break the same way twice, or paging is nonsense", () => {
    const once = fuse([source("a", 4), source("b", 4)]).map((row) => `${row.key}/${row.path}`);
    const again = fuse([source("b", 4), source("a", 4)]).map((row) => `${row.key}/${row.path}`);
    expect(again).toEqual(once);
  });

  test("the same note in two contexts is two notes; the same source twice is one", () => {
    const a = { ...source("a", 1), hits: [{ path: "1-projects/plan.md", title: "Plan", snippets: [] }] };
    const b = { ...source("b", 1), hits: [{ path: "1-projects/plan.md", title: "Plan", snippets: [] }] };
    expect(fuse([a, b]).length).toBe(2);
    expect(fuse([a, a]).length).toBe(1);
  });
});

describe("paging across sources", () => {
  test("page two resumes each context where page one stopped reading it", () => {
    const sources = [source("a", 30, 0, 30), source("b", 2, 0, 30)];
    const first = pageOf(fuse(sources), sources, 4);
    expect(first.next).not.toBeNull();
    // `b` gave both of its results to page one; `a` gave two. So page two
    // resumes `a` at rank 2 and `b` at rank 2 — not both at "four results in",
    // which is what a single global offset would say.
    expect(first.next).toEqual({ a: 2, b: 2 });
  });

  test("a page that exhausts every source offers no cursor", () => {
    const sources = [source("a", 2, 0, BLEND_PAGE_SIZE), source("b", 1, 0, BLEND_PAGE_SIZE)];
    expect(pageOf(fuse(sources), sources).next).toBeNull();
  });

  test("a source that filled its window keeps the cursor alive", () => {
    const sources = [source("a", 5, 0, 5)];
    expect(pageOf(fuse(sources), sources, 10).next).toEqual({ a: 5 });
  });

  test("nothing pages past the rank the ranker stops at", () => {
    expect(depthFor(0)).toBe(BLEND_PAGE_SIZE);
    expect(depthFor(MAX_SOURCE_DEPTH)).toBe(MAX_SOURCE_DEPTH);
    expect(depthFor(MAX_SOURCE_DEPTH * 10)).toBe(MAX_SOURCE_DEPTH);
    // A source already read to the last rank reports itself finished rather
    // than asking for a page that does not exist.
    const sources = [source("a", MAX_SOURCE_DEPTH, MAX_SOURCE_DEPTH, MAX_SOURCE_DEPTH)];
    expect(pageOf(fuse(sources), sources).next).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                          the cursor, as an attack                          */
/* -------------------------------------------------------------------------- */

describe("a cursor is arithmetic and nothing else", () => {
  const print = queryFingerprint("review cycle");

  test("it carries no trace of the words somebody typed", () => {
    const cursor = encodeCursor(print, { ws1: 3 });
    expect(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("review");
    expect(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))).not.toContain("cycle");
  });

  test("a cursor for another query is ignored rather than honoured", () => {
    const cursor = encodeCursor(queryFingerprint("something else"), { ws1: 3 });
    expect(decodeCursor(cursor, print)).toEqual({ kind: "fresh" });
  });

  test("a round trip survives", () => {
    expect(decodeCursor(encodeCursor(print, { ws1: 3, ws2: 7 }), print)).toEqual({
      kind: "page",
      offsets: { ws1: 3, ws2: 7 },
    });
  });

  test("garbage, and every arithmetic attack, lands on the first page", () => {
    for (const raw of ["", "not-base64!!", btoa("[]"), btoa('{"v":2,"q":"x","at":{}}'), "x".repeat(9000)]) {
      expect(decodeCursor(raw, print).kind).toBe("fresh");
    }
    // A negative offset would slice from the END of a ranked list, which is a
    // page nobody could otherwise reach; a fractional one slices at nothing;
    // an enormous one asks for a rank that does not exist.
    const forged = btoa(
      JSON.stringify({ v: 1, q: print, at: { a: -1, b: 2.7, c: 1e9, d: "3", e: Infinity } }),
    );
    expect(decodeCursor(forged, print)).toEqual({
      kind: "page",
      offsets: { b: 2, c: MAX_SOURCE_DEPTH },
    });
  });
});

describe("a scope can only ever narrow", () => {
  const eligible = [
    { workspaceId: "ws_mine", slug: "mine", displayName: "Mine" },
    { workspaceId: "ws_ours", slug: "ours", displayName: "Ours" },
  ];

  test("no scope means every eligible context", () => {
    expect(resolveScope(eligible, undefined).length).toBe(2);
    expect(resolveScope(eligible, []).length).toBe(2);
  });

  test("an id this caller may not search is dropped, not refused", () => {
    expect(resolveScope(eligible, ["ws_mine", "ws_theirs"]).map((c) => c.workspaceId)).toEqual([
      "ws_mine",
    ]);
    // And a list of nothing but forbidden ids is an empty scope rather than an
    // error — the same answer a list of invented ids gives.
    expect(resolveScope(eligible, ["ws_theirs"]).length).toBe(0);
    expect(resolveScope(eligible, ["ws_never_existed"]).length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*                    the fan-out, through the control plane                  */
/* -------------------------------------------------------------------------- */

/**
 * Two tenants, each with their own bucket, both with fast search switched on.
 *
 * The buckets are addressed path-style, so one `fetch` stub can route by the
 * first path segment: a request for the wrong bucket reaches the wrong stub
 * and is answered `NoSuchBucket`, exactly as a provider would. That routing is
 * what lets the isolation tests below assert over one tenant's **recorded
 * requests** rather than over the response — a bucket that was read and then
 * omitted from the answer is still a bucket that was read.
 */
interface Tenants {
  t: TestConvex;
  alice: Id<"users">;
  bob: Id<"users">;
  aliceWs: Id<"workspaces">;
  bobWs: Id<"workspaces">;
  aliceBucket: MemoryS3;
  bobBucket: MemoryS3;
}

const ALICE_BUCKET = "alice-example-bucket";
const BOB_BUCKET = "bob-example-bucket";

/** A word that appears only in Bob's private half. */
const BOB_PRIVATE_WORD = "wallabyrate";
/** A word both tenants wrote about, so a blend has something to blend. */
const SHARED_WORD = "quokkaplan";

function seedBucket(bucket: MemoryS3, name: string): void {
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("index.md", `# ${name}\n`);
  bucket.seed("1-projects/README.md", "# Projects\n");
  bucket.seed("1-projects/plan.md", `# ${name} plan\n\nThe ${SHARED_WORD} ships in March.\n`);
  bucket.seed("2-areas/README.md", "# Areas\n");
}

async function bindBucket(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  boundBy: Id<"users">,
  bucket: string,
): Promise<void> {
  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** A `searchIndexes` row in the one state `searchableContexts` accepts. */
async function switchFastSearchOn(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  optedInBy: Id<"users">,
): Promise<void> {
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("searchIndexes", {
      workspaceId,
      optedIn: true,
      optedInBy,
      optedInAt: now,
      status: "ready" as const,
      // Obviously fake, and never opened: this deployment has no Cloudflare
      // credential seeded, so `clientFor` returns null and every search falls
      // through to the R2 index in the customer's own bucket. That is the
      // honest arrangement for this file — the fan-out, the scope and the
      // privacy filter are what is under test, and they are identical either
      // way. `consoleSearch.test.ts` owns the projection's own behaviour.
      databaseId: "example0000d1000database000id00",
      databaseName: "context-search-example",
      createdAt: now,
      updatedAt: now,
    }),
  );
}

/** Build the R2 shard index until it converges, so a search has one to read. */
async function indexBucket(t: TestConvex, workspaceId: Id<"workspaces">): Promise<void> {
  for (let pass = 0; pass < 12; pass += 1) {
    const result = await t.action(internal.functions.files.runFileOperation, {
      workspaceId,
      scope: "private" as const,
      operation: { kind: "maintainIndex" as const },
    });
    if (result.kind === "indexMaintained" && result.complete) return;
  }
  throw new Error("the index never converged");
}

async function twoTenants(): Promise<Tenants> {
  const t = setupTest();
  const alice = await createUser(t, "alice@example.invalid");
  const bob = await createUser(t, "bob@example.invalid");
  const aliceWs = await createWorkspace(t, alice, "alice-context");
  const bobWs = await createWorkspace(t, bob, "bob-context");

  const aliceBucket = memoryS3(ALICE_BUCKET);
  const bobBucket = memoryS3(BOB_BUCKET);
  seedBucket(aliceBucket, "Alice");
  seedBucket(bobBucket, "Bob");
  bobBucket.seed("2-areas/pay.md", `# Pay\n\nThe ${BOB_PRIVATE_WORD} is confidential.\n`);

  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const first = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
    if (first === BOB_BUCKET) return await bobBucket.fetchImpl(input, init);
    return await aliceBucket.fetchImpl(input, init);
  });

  await bindBucket(t, aliceWs, alice, ALICE_BUCKET);
  await bindBucket(t, bobWs, bob, BOB_BUCKET);
  await switchFastSearchOn(t, aliceWs, alice);
  await switchFastSearchOn(t, bobWs, bob);
  await indexBucket(t, aliceWs);
  await indexBucket(t, bobWs);

  return { t, alice, bob, aliceWs, bobWs, aliceBucket, bobBucket };
}

describe("the blended search, across contexts", () => {
  test("a member of both contexts gets both, blended and labelled", async () => {
    const f = await twoTenants();
    // Bob invites Alice in as a plain member, which is `team` clearance — so
    // she sees his notes only where he has shared the folder. A scaffold is
    // private by default, which is why the share is part of the fixture rather
    // than an extra: without it this test would pass for the wrong reason on
    // one side and fail on the other.
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    await asUser(f.t, f.bob).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.bobWs,
      path: "1-projects",
      visibility: "team",
    });
    await indexBucket(f.t, f.bobWs);

    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    const slugs = new Set(answer.results.map((row) => row.slug));
    expect(slugs).toEqual(new Set(["alice-context", "bob-context"]));
    // Every row says which context it came from, because a blended list where
    // it does not is a list of paths from nowhere.
    for (const row of answer.results) {
      expect(row.workspaceId).toBeTruthy();
      expect(row.path).toContain("plan.md");
    }
    expect(answer.sources.map((row) => row.state)).toEqual(["ok", "ok"]);
    expect(answer.eligibleCount).toBe(2);
  });

  test("a context the caller is not in is never searched and never named", async () => {
    const f = await twoTenants();
    const before = f.bobBucket.requests.length;

    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      contexts: [f.aliceWs, f.bobWs],
    });

    // Not in the results, not in the source list, and — the assertion that
    // actually bites — not touched. A response that omitted what it read would
    // pass the first two.
    expect(answer.results.every((row) => row.slug === "alice-context")).toBe(true);
    expect(answer.sources.map((row) => row.slug)).toEqual(["alice-context"]);
    expect(JSON.stringify(answer)).not.toContain(f.bobWs);
    expect(f.bobBucket.requests.length).toBe(before);
  });

  test("naming another tenant's context is indistinguishable from naming nothing", async () => {
    const f = await twoTenants();
    const as = asUser(f.t, f.alice);
    const theirs = await as.action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      contexts: [f.bobWs],
    });
    const nowhere = await as.action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      contexts: [],
    });
    // `contexts: []` means "every eligible context", which for Alice is her
    // own — so the comparison that matters is against a scope of ids she
    // cannot use, which must come back empty rather than as an error.
    expect(theirs.results).toEqual([]);
    expect(theirs.sources).toEqual([]);
    expect(theirs.matchCount).toBe(0);
    // And the state that tells the page which sentence to draw is intact: she
    // *has* an eligible context, she just did not select it.
    expect(theirs.eligibleCount).toBe(1);
    expect(nowhere.results.length).toBeGreaterThan(0);
  });

  test("a crafted cursor cannot add a context to the scope", async () => {
    const f = await twoTenants();
    const before = f.bobBucket.requests.length;
    const forged = encodeCursor(queryFingerprint(SHARED_WORD), {
      [f.aliceWs]: 0,
      [f.bobWs]: 0,
    });

    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      cursor: forged,
    });

    expect(answer.sources.map((row) => row.slug)).toEqual(["alice-context"]);
    expect(f.bobBucket.requests.length).toBe(before);
  });

  test("a member sees the team tier, and the count is the one they can see", async () => {
    const f = await twoTenants();
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    // Bob shares his projects folder but not the note in `2-areas`.
    await asUser(f.t, f.bob).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.bobWs,
      path: "1-projects",
      visibility: "team",
    });
    await indexBucket(f.t, f.bobWs);

    const asAlice = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: BOB_PRIVATE_WORD,
      contexts: [f.bobWs],
    });
    // Not the path, not the snippet, and **not the count**: "1 match" over
    // zero results is the subtraction this whole system is careful about.
    expect(asAlice.results).toEqual([]);
    expect(asAlice.matchCount).toBe(0);
    expect(JSON.stringify(asAlice)).not.toContain(BOB_PRIVATE_WORD);

    // Sabotage guard: the word really is findable, so the assertion above is
    // about the scope rather than about a search that finds nothing at all.
    const asBob = await asUser(f.t, f.bob).action(api.functions.files.searchContexts, {
      query: BOB_PRIVATE_WORD,
      contexts: [f.bobWs],
    });
    expect(asBob.results.map((row) => row.path)).toEqual(["2-areas/pay.md"]);
    expect(asBob.matchCount).toBe(1);
  });

  test("a context whose fast search is off is not searched, and the page is told why", async () => {
    const f = await twoTenants();
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { optedIn: false });
    });

    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    // Zero eligible contexts is its own sentence on screen. An empty result
    // list with `eligibleCount: 0` says "nothing looked"; the same list with a
    // positive count says "nothing matched", and they are not the same claim.
    expect(answer.results).toEqual([]);
    expect(answer.eligibleCount).toBe(0);
    expect(answer.sources).toEqual([]);
  });

  test("a context still filling its index is not searched either", async () => {
    const f = await twoTenants();
    await f.t.run(async (ctx) => {
      const row = await ctx.db
        .query("searchIndexes")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.aliceWs))
        .unique();
      await ctx.db.patch(row!._id, { status: "backfilling" });
    });

    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    // `backfilling` is a database that exists and is not finished, which is the
    // one state that would answer a query about a note it has not copied with
    // a silence this page would render as "nothing here". `ready` is the only
    // acceptable state and the guard is `!== "ready"` rather than `!== null`.
    expect(answer.eligibleCount).toBe(0);
    expect(answer.results).toEqual([]);
    const offered = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    expect(offered).toEqual([]);
  });

  test("an empty query asks nobody anything", async () => {
    const f = await twoTenants();
    const before = f.aliceBucket.requests.length;
    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: "   ",
    });
    expect(answer.results).toEqual([]);
    expect(answer.cursor).toBeNull();
    expect(f.aliceBucket.requests.length).toBe(before);
  });

  test("a signed-out caller is turned away before any bucket is opened", async () => {
    const f = await twoTenants();
    const before = f.aliceBucket.requests.length;
    await expect(
      f.t.action(api.functions.files.searchContexts, { query: SHARED_WORD }),
    ).rejects.toThrow();
    expect(f.aliceBucket.requests.length).toBe(before);
  });

  test("the scope picker offers exactly what the fan-out will search", async () => {
    const f = await twoTenants();
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    const offered = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    // A chip the fan-out would refuse is a control that does nothing, and a
    // context the fan-out searches without a chip is a scope nobody can turn
    // off. Both are the same equality.
    expect(offered.map((row) => row.workspaceId).sort()).toEqual(
      answer.sources.map((row) => row.workspaceId).sort(),
    );
    // And it names only contexts this caller belongs to.
    expect(offered.map((row) => row.slug).sort()).toEqual(["alice-context", "bob-context"]);
  });

  test("a context that cannot be reached costs itself, and the total says so", async () => {
    const f = await twoTenants();
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    await asUser(f.t, f.bob).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.bobWs,
      path: "1-projects",
      visibility: "team",
    });
    await indexBucket(f.t, f.bobWs);

    // Bob's bucket stops answering. A rejection and a timeout reach the same
    // line — `withDeadline` returns `null` for both — so this drives the
    // partial-failure path without making the suite wait seven seconds for it.
    let bobIsDown = true;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : String(input));
      const first = decodeURIComponent(url.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
      if (first === BOB_BUCKET) {
        if (bobIsDown) throw new TypeError("network error: connection refused");
        return await f.bobBucket.fetchImpl(input, init);
      }
      return await f.aliceBucket.fetchImpl(input, init);
    });

    const partial = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    // The rest of the page still arrives. One unreachable bucket holding every
    // other context's results behind it is the failure a blended list makes
    // worse rather than better.
    expect(partial.results.map((row) => row.slug)).toEqual(["alice-context"]);
    const rows = new Map(partial.sources.map((row) => [row.slug, row]));
    expect(rows.get("bob-context")?.state).toBe("failed");
    expect(rows.get("alice-context")?.state).toBe("ok");
    // **And the total is a floor.** A source that was never read is a walk cut
    // short, which is the one condition under which every other count in this
    // system stops claiming to be exact. Without this the page would print a
    // confident number over a scope it only half searched.
    expect(partial.matchCount).toBeGreaterThan(0);
    expect(partial.matchCountIsFloor).toBe(true);
    // A failed row says which context and nothing about why: the reason would
    // be a storage provider's sentence about somebody else's bucket.
    expect(JSON.stringify(partial)).not.toContain("connection refused");

    // Per-source retry is the same call with that one id in `contexts`, which
    // is the whole of the retry story — there is no second endpoint.
    bobIsDown = false;
    const retry = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      contexts: [f.bobWs],
    });
    expect(retry.sources.map((row) => row.state)).toEqual(["ok"]);
    expect(retry.results.map((row) => row.slug)).toEqual(["bob-context"]);
    expect(retry.matchCountIsFloor).toBe(false);
  });

  test("a member removed between two pages does not keep the context", async () => {
    const f = await twoTenants();
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    await asUser(f.t, f.bob).action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.bobWs,
      path: "1-projects",
      visibility: "team",
    });
    await indexBucket(f.t, f.bobWs);

    const first = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    expect(first.sources.map((row) => row.slug).sort()).toEqual([
      "alice-context",
      "bob-context",
    ]);

    // Bob takes her out of the workspace between one request and the next.
    await f.t.run(async (ctx) => {
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_user", (q) => q.eq("userId", f.alice))
        .collect();
      for (const membership of memberships) {
        if (membership.workspaceId === f.bobWs) await ctx.db.delete(membership._id);
      }
    });

    const before = f.bobBucket.requests.length;
    const next = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      // A cursor she legitimately held a moment ago, naming the context she has
      // just lost. This is the crafted-cursor attack without the crafting: the
      // scope is re-resolved from live memberships every page, so the offsets
      // for a context no longer in it are read by nobody.
      cursor: encodeCursor(queryFingerprint(SHARED_WORD), {
        [f.aliceWs]: 0,
        [f.bobWs]: 0,
      }),
    });
    expect(next.sources.map((row) => row.slug)).toEqual(["alice-context"]);
    expect(next.eligibleCount).toBe(1);
    expect(JSON.stringify(next)).not.toContain(f.bobWs);
    // Not merely absent from the answer — not read. A response that omits what
    // it touched is still a touch.
    expect(f.bobBucket.requests.length).toBe(before);
  });

  test("page two resumes each context, through the action and its cursor", async () => {
    const f = await twoTenants();
    // Enough matches that one page cannot hold them: `BLEND_PAGE_SIZE` results
    // come back and a cursor says where each source stopped. Without this the
    // offset wiring in `searchContexts` — `offsets[workspaceId]`, and the depth
    // it asks for — is never exercised by anything but a unit test of the
    // arithmetic it feeds.
    for (let index = 0; index < BLEND_PAGE_SIZE + 4; index += 1) {
      f.aliceBucket.seed(
        `1-projects/note-${index}.md`,
        `# Note ${index}\n\nThe ${SHARED_WORD} again, item ${index}.\n`,
      );
    }
    await indexBucket(f.t, f.aliceWs);

    const as = asUser(f.t, f.alice);
    const one = await as.action(api.functions.files.searchContexts, { query: SHARED_WORD });
    expect(one.results.length).toBe(BLEND_PAGE_SIZE);
    expect(one.cursor).not.toBeNull();

    const two = await as.action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
      cursor: one.cursor ?? undefined,
    });
    expect(two.results.length).toBeGreaterThan(0);
    // Page two is below page one rather than page one again, which is the whole
    // point of a per-source offset.
    const firstPaths = new Set(one.results.map((row) => `${row.slug}/${row.path}`));
    for (const row of two.results) {
      expect(firstPaths.has(`${row.slug}/${row.path}`)).toBe(false);
    }

    // A cursor from this query cannot page a different one: the fingerprint
    // does not match, so the reader starts at the top rather than splicing one
    // query's second page onto another's first.
    const other = await as.action(api.functions.files.searchContexts, {
      query: "Alice",
      cursor: one.cursor ?? undefined,
    });
    expect(other.results.some((row) => firstPaths.has(`${row.slug}/${row.path}`))).toBe(false);
  });
});
