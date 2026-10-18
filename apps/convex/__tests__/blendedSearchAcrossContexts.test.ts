/**
 * The blended search across contexts: membership, scope, privacy and tenant
 * isolation through the control plane. Fixtures live in blendedSearch.helpers.ts.
 */

import { describe, expect, test, vi, afterEach } from "vitest";
import { api } from "../_generated/api";
import { BLEND_PAGE_SIZE, encodeCursor, queryFingerprint } from "../functions/lib/blendedSearch";
import { addMember, asUser, copyTree } from "./fixtures.helpers";
import {
  BOB_BUCKET,
  BOB_PRIVATE_WORD,
  SHARED_WORD,
  indexBucket,
  twoTenants,
} from "./blendedSearch.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    expect(answer.searchableCount).toBe(2);
    // Each row says when its note was last written, from the tree's row
    // ("edited Sep 12" on the console's result rows, 2026-10-17).
    for (const row of answer.results) expect(typeof row.edited).toBe("number");
  }, 15_000);

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
    // `contexts: []` means "every context she can search", which for Alice is
    // her own — so the comparison that matters is against a scope of ids she
    // cannot use, which must come back empty rather than as an error.
    expect(theirs.results).toEqual([]);
    expect(theirs.sources).toEqual([]);
    expect(theirs.matchCount).toBe(0);
    // And the state that tells the page which sentence to draw is intact: she
    // *has* a context she could search, she just did not select it.
    expect(theirs.searchableCount).toBe(1);
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

  test("a context whose fast search is off is still searched, from its own bucket", async () => {
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
    // THE REGRESSION THIS FILE EXISTS TO HOLD DOWN. This page used to answer a
    // person with four contexts and a question with "no context you can reach
    // has fast search switched on, so nothing was searched" — a dead end built
    // out of a performance budget. `lib/fastSearch.ts` has always said what off
    // means: "the existing R2 shard index serves the search, exactly as it does
    // today… the fast path is an upgrade, and its absence is the product as it
    // already is."
    expect(answer.results.length).toBeGreaterThan(0);
    expect(answer.searchableCount).toBe(1);
    expect(answer.sources.map((row) => row.slug)).toEqual(["alice-context"]);

    // And the scope says how it was answered, which is what the page's upsell
    // is built from — never by dropping the context out of the list.
    const scope = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    expect(scope.contexts).toEqual([
      expect.objectContaining({
        slug: "alice-context",
        search: "slow",
        fastSearch: "off",
        owner: true,
      }),
    ]);
  });

  test("a context still filling its index is searched too, and says it is preparing", async () => {
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
    // `backfilling` used to be excluded, on the argument that a half-copied
    // database answers a query about a note it has not copied with a silence
    // this page would render as "nothing here". The silence was never real:
    // the gateway's projection reader treats a miss as a reason to go and ask
    // the R2 index the expensive way, and "only a *hit* short-circuits" — so a
    // half-built index cannot lose a result the slow path would have found. It
    // can only be slower, which is a sentence on the page, not a reason to
    // leave somebody's context out of their own search.
    expect(answer.searchableCount).toBe(1);
    expect(answer.results.length).toBeGreaterThan(0);
    const scope = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    expect(scope.contexts).toEqual([
      expect.objectContaining({
        slug: "alice-context",
        search: "slow",
        fastSearch: "preparing",
        owner: true,
      }),
    ]);
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
    const scope = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    const answer = await asUser(f.t, f.alice).action(api.functions.files.searchContexts, {
      query: SHARED_WORD,
    });
    // A chip the fan-out would refuse is a control that does nothing, and a
    // context the fan-out searches without a chip is a scope nobody can turn
    // off. Both are the same equality.
    expect(scope.contexts.map((row) => row.workspaceId).sort()).toEqual(
      answer.sources.map((row) => row.workspaceId).sort(),
    );
    // And it names only contexts this caller belongs to.
    expect(scope.contexts.map((row) => row.slug).sort()).toEqual([
      "alice-context",
      "bob-context",
    ]);
    // Both are serving, so both are searched the fast way.
    expect(scope.contexts.every((row) => row.search === "fast")).toBe(true);
  });

  test("a context off the fast path is in the scope, and says whose decision that is", async () => {
    const f = await twoTenants();
    // Bob turns his off; Alice, a plain member of it, cannot turn it back on.
    await addMember(f.t, f.bobWs, f.alice, "member", f.bob);
    await asUser(f.t, f.bob).mutation(api.functions.fastSearch.disable, {
      workspaceId: f.bobWs,
    });

    const bobsView = await asUser(f.t, f.bob).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    const alicesView = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );

    // Bob owns it, so the page may offer him the press that changes it.
    expect(bobsView.contexts).toEqual([
      expect.objectContaining({
        slug: "bob-context",
        search: "slow",
        fastSearch: "off",
        owner: true,
      }),
    ]);
    // Alice does not, so the page tells her whose decision it is and offers
    // her nothing to press — a button that reaches a permission error is worse
    // than no button.
    expect(alicesView.contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: "bob-context",
          search: "slow",
          fastSearch: "off",
          owner: false,
        }),
      ]),
    );
    // And both of her contexts are searched, whatever their state.
    expect(alicesView.contexts.map((row) => row.slug).sort()).toEqual([
      "alice-context",
      "bob-context",
    ]);
  });

  test("a context this caller is not a member of never appears in the scope at all", async () => {
    const f = await twoTenants();
    // Bob's context is opted out — the shape the upsell would name if it
    // leaked — and Alice has never been a member of it.
    await asUser(f.t, f.bob).mutation(api.functions.fastSearch.disable, {
      workspaceId: f.bobWs,
    });

    const scope = await asUser(f.t, f.alice).query(
      api.functions.fastSearch.searchableContexts,
      {},
    );
    // Same isolation bar as the search itself, and now a single list rather
    // than two: a workspace the caller does not belong to must not be
    // enumerable through the scope any more than through the fan-out — see
    // `searchScopeFor`'s header. Widening the list to every membership is
    // exactly the change that makes this assertion worth re-reading.
    expect(scope.contexts.some((row) => row.slug === "bob-context")).toBe(false);
    expect(JSON.stringify(scope)).not.toContain(f.bobWs);
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
    expect(next.searchableCount).toBe(1);
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
    // Written straight into the bucket, so the tree copies them before the index reads its census.
    await copyTree(f.t, f.aliceWs);
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
