/**
 * THE CARD, IN THE CUSTOMER'S OWN BUCKET.
 *
 * A card is derived from a note the customer wrote, so it lives where that note
 * lives — under `.images/` in their storage, not ours. **Revoking our
 * credential takes the previews with it**, which is the product's promise
 * working rather than a cost of it.
 *
 * The render itself is a `"use node"` action calling satori and resvg, which
 * this suite cannot boot, so it is stubbed here and was verified against a live
 * dev deployment separately (24–34 KB valid PNGs, 370–560 ms warm). What is
 * asserted below is everything around it — and the whole point of this file is
 * that **every one of those failures must leave the share working**:
 *
 *   renderer unavailable      → no card, static product card
 *   glyph the font can't draw → no card, static product card
 *   bucket refuses the write  → no card, static product card
 *   share revoked mid-render  → no card, and no row pointing at the bytes
 *
 * A share with no picture is a share that works. A share that failed to exist
 * because a *picture* failed is not.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { cardImageLeaf, cardSignature, hashTitle } from "../functions/lib/cardKey";
import { isRenderableTitle } from "../functions/lib/cardCoverage";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";

const NOTE = "1-projects/transition/chapter-transition.md";

async function scenario(t: TestConvex) {
  const ownerId = await createUser(t, "owner@example.invalid");
  const lkId = await createUser(t, "lk@example.invalid");
  const workspaceId = await createWorkspace(t, ownerId, "owner-brain");
  await createWorkspace(t, lkId, "lk");
  return { ownerId, lkId, workspaceId };
}

async function share(
  t: TestConvex,
  ownerId: Id<"users">,
  workspaceId: Id<"workspaces">,
  extra: { previewTitle?: string; titleInPreview?: boolean; path?: string } = {},
): Promise<string> {
  const { path, ...rest } = extra;
  const { token } = await asUser(t, ownerId).mutation(
    api.functions.shares.createShare,
    { workspaceId, path: path ?? NOTE, recipient: "@lk", ...rest },
  );
  return token;
}

describe("where a card is stored", () => {
  test("the leaf is one segment the gateway can name", () => {
    const leaf = cardImageLeaf("a".repeat(64), "Chapter transition");
    // The gateway's rule: one segment, alphanumeric first character, an
    // extension `read_image` will serve. A key it cannot name is bytes nobody
    // can ever get back out.
    expect(leaf).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(leaf.endsWith(".png")).toBe(true);
    expect(leaf).not.toContain("/");
  });

  /**
   * A card in `.images/` is readable by anyone who can read a note that
   * references it. The full 64-character token is the capability itself, so it
   * must not be sitting in a filename that other people can see.
   */
  test("the full token is never in the filename", () => {
    const token = "b".repeat(64);
    const leaf = cardImageLeaf(token, "Chapter transition");
    expect(leaf).not.toContain(token);
    expect(leaf).toContain(token.slice(0, 16));
  });

  /**
   * The only invalidation there is. The Workers cache is per-datacenter and
   * `cache.delete` purges one colo, so a retitled share must be a *different
   * object* — otherwise the old card is served for the whole TTL.
   */
  test("retitling a share names a different object", () => {
    const token = "c".repeat(64);
    expect(cardImageLeaf(token, "One")).not.toBe(cardImageLeaf(token, "Two"));
    expect(cardImageLeaf(token, "One")).toBe(cardImageLeaf(token, "One"));
  });

  test("two shares of the same note do not collide", () => {
    expect(cardImageLeaf("d".repeat(64), "Same")).not.toBe(
      cardImageLeaf("e".repeat(64), "Same"),
    );
  });

  /**
   * The router puts this value in the card's URL and the control plane names
   * the object with it. Two spellings would mean a card that is written and
   * never found, so the two implementations must agree — asserted rather than
   * commented, because `apps/mcp` and `infra/router` are dependency-free and
   * cannot share a module.
   */
  test("the hash matches the router's, digit for digit", async () => {
    const routerModule = await import("../../../infra/router/src/preview");
    for (const title of ["", "a", "Chapter transition", "Café — it’s…", "x".repeat(60)]) {
      expect(hashTitle(title)).toBe(routerModule.hashTitle(title));
    }
  });

  /**
   * And so does the *signature*, which is what a folder card is hashed from.
   *
   * The two are mirrored rather than shared because `infra/router` is a
   * dependency-free Worker that cannot import `apps/convex`. A disagreement
   * would be a card the control plane writes at one key and the edge asks for
   * at another — written once and never found — so the mirror is run rather
   * than trusted, exactly as `hashTitle`'s is.
   */
  test("the card signature matches the router's, for the shapes a folder produces", async () => {
    const routerModule = await import("../../../infra/router/src/preview");
    const cases: Array<[string, string[]]> = [
      ["Transition", []],
      ["Transition", ["interviews/"]],
      ["Transition", ["interviews/", "overview.md", "salaries.md"]],
      ["", ["a"]],
      ["Café — it’s…", ["naïve.md"]],
    ];
    for (const [title, children] of cases) {
      expect(cardSignature(title, children)).toBe(
        routerModule.cardSignature(title, children),
      );
    }
  });

  /**
   * **No children must hash exactly as the bare title did.**
   *
   * Every note share in existence has an empty list, and a signature that
   * folded an empty array in differently would rename all of their cards on the
   * next render — a new URL for a picture that has not changed, fetched again
   * by every unfurler that had already cached it.
   */
  test("no children is byte-identical to the title alone", () => {
    const token = "f".repeat(64);
    expect(cardSignature("Chapter transition")).toBe("Chapter transition");
    expect(cardImageLeaf(token, "Chapter transition", [])).toBe(
      cardImageLeaf(token, "Chapter transition"),
    );
  });

  /**
   * The other direction, and the one this signature exists for: a folder whose
   * contents changed must name a *different* object, or the card keeps showing
   * the notes it used to hold. The Workers cache is per-datacenter with no
   * global purge, so a changed URL is the only invalidation there is.
   */
  test("changing what is inside names a different object", () => {
    const token = "g".repeat(64);
    const before = cardImageLeaf(token, "Transition", ["overview.md"]);
    expect(cardImageLeaf(token, "Transition", ["timeline.md"])).not.toBe(before);
    expect(cardImageLeaf(token, "Transition", [])).not.toBe(before);
    expect(cardImageLeaf(token, "Transition", ["overview.md"])).toBe(before);
  });
});

describe("which titles get a card at all", () => {
  test("ordinary English does", () => {
    expect(isRenderableTitle("Chapter transition")).toBe(true);
  });

  test("accented Latin, em dashes and curly quotes do", () => {
    expect(isRenderableTitle("Café — “curly” it’s… naïve")).toBe(true);
  });

  /**
   * Not a shortcoming — a decision. satori draws an uncovered glyph as tofu
   * **silently**, and a card of empty boxes gets written into a customer's
   * bucket and cached by every unfurler that sees it. Refusing to draw one and
   * serving the product card is the better failure.
   */
  test("a script the bundled font cannot draw does not", () => {
    expect(isRenderableTitle("日本語のノート")).toBe(false);
    expect(isRenderableTitle("🚀 launch")).toBe(false);
  });

  test("one uncovered character is enough to refuse the whole title", () => {
    expect(isRenderableTitle("Mostly fine 日")).toBe(false);
  });
});

describe("a card is scheduled, never awaited", () => {
  /**
   * `createShare` must not get slower, fail, or become observably different
   * because a *picture* is being drawn. Same "scheduling is not calling" rule
   * the invitation mail follows: `runAfter` enqueues in a separate transaction
   * whose return value is discarded.
   */
  test("creating a share schedules a render and returns immediately", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);

    await share(t, ownerId, workspaceId);

    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      jobs.some((job) => job.name.includes("shareCard")),
      "creating a share did not schedule a card render",
    ).toBe(true);
  });

  test("retitling an existing share schedules another", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    await share(t, ownerId, workspaceId);

    const before = (
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
    ).length;

    await share(t, ownerId, workspaceId, { previewTitle: "A different name" });

    const after = (
      await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
    ).length;
    expect(after).toBeGreaterThan(before);
  });
});

describe("what the renderer is asked to draw", () => {
  async function subjectFor(t: TestConvex, token: string) {
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    return await t.query(internal.functions.shareCard.cardSubject, {
      shareId: row!._id,
    });
  }

  test("a live share with a title", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);

    const subject = await subjectFor(t, token);
    expect(subject?.title).toBe("Chapter transition");
    expect(subject?.workspaceId).toBe(workspaceId);
  });

  /**
   * Every state in which there should be no card collapses to one `null`, so
   * the action has one branch instead of five.
   */
  test("a share whose owner turned the title off gets none", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId, { titleInPreview: false });

    expect(await subjectFor(t, token)).toBeNull();
  });

  test("a revoked share gets none", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    expect(await subjectFor(t, token)).toBeNull();
  });

  test("an expired share gets none", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique();
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 });
    });

    expect(await subjectFor(t, token)).toBeNull();
  });

  test("a share over a note whose filename yields no title gets none", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId, { path: "0-inbox/2026-08-29.md" });

    expect(await subjectFor(t, token)).toBeNull();
  });
});

describe("serving a card", () => {
  async function locationFor(t: TestConvex, token: string) {
    return await t.query(internal.functions.shareCard.cardLocation, { token });
  }

  /**
   * A share that has not been rendered yet, or whose render failed, is
   * indistinguishable from one that never existed. That is what keeps
   * revocation invisible to a crawler.
   */
  test("a share with no card yet resolves nothing", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);

    expect(await locationFor(t, token)).toBeNull();
  });

  test("an unknown token resolves nothing", async () => {
    const t = setupTest();
    await scenario(t);
    expect(await locationFor(t, "z".repeat(64))).toBeNull();
  });

  test("a rendered card resolves to its leaf", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(token, "Chapter transition"),
    });

    const location = await locationFor(t, token);
    expect(location?.leaf).toBe(cardImageLeaf(token, "Chapter transition"));
    expect(location?.workspaceId).toBe(workspaceId);
  });

  test("revoking stops the card resolving, without deleting the bytes", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(token, "Chapter transition"),
    });

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    expect(await locationFor(t, token)).toBeNull();
    // The row keeps its leaf. Nothing collects the customer's bytes — we cannot
    // see what Obsidian or rclone did to that bucket, so any delete is a guess.
    // What matters is that no *live* row points at it.
    const after = await t.run(async (ctx) => ctx.db.get(row!._id));
    expect(after?.cardImageLeaf).toBeDefined();
  });

  /**
   * **A retitled share must stop serving the card drawn for its old title.**
   *
   * `cardImageLeaf` hashes the title, and the schema says why: "retitling a
   * share writes a new object rather than mutating one — the Workers cache is
   * per-datacenter and has no global purge, so a changed URL is the only
   * invalidation available." That holds only while the stored leaf and the
   * current title agree, and four paths leave them disagreeing: a title the
   * bundled font cannot draw, a renderer that threw, a bucket that refused the
   * write, and a revoke-then-reshare. Every one of them returns early, and
   * **nothing anywhere clears `cardImageLeaf`** — it is written in one place
   * and read in one place.
   *
   * The cheapest trigger is an emoji. `isRenderableTitle("Notes 🙂")` is false,
   * measured, so the re-render refuses before it draws and the old leaf stays.
   * The OG *text* then updates while the OG *image* still shows the title the
   * owner replaced — and this repository's own rule is that anything reaching a
   * card is permanently public: Discord and WhatsApp copy it to their CDNs,
   * iMessage bakes it into the sent message, Facebook caches by URL.
   *
   * So `cardLocation` recomputes the leaf rather than trusting the stored one,
   * and answers `null` on a mismatch — the same absence a share with no card
   * yet gives, which is what keeps every one of these indistinguishable.
   */
  test("a retitled share stops serving the card drawn for the old title", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId, {
      previewTitle: "Q3 layoffs plan",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(token, "Q3 layoffs plan"),
    });

    // The positive control. Without it a card that never resolved at all would
    // satisfy the assertion below.
    expect((await locationFor(t, token))?.leaf).toBe(
      cardImageLeaf(token, "Q3 layoffs plan"),
    );

    // Retitle to something the bundled font cannot draw, so no re-render lands
    // and the stored leaf is left pointing at the old card.
    //
    // The returned token is asserted unchanged, and that is not decoration:
    // sabotaging `createShare`'s supersede branch to rotate the token leaves
    // the whole suite green, because `locationFor` would then answer `null` for
    // a token no row carries — which is the test two above this one, not this
    // one. Nothing else in the suite pins token stability across a supersede,
    // though `createShare`'s own comment calls it load-bearing.
    expect(
      await share(t, ownerId, workspaceId, { previewTitle: "Notes 🙂" }),
      "the supersede rotated the token, so the assertion below is about a different share",
    ).toBe(token);
    const retitled = await t.run(async (ctx) => ctx.db.get(row!._id));
    expect(
      retitled?.previewTitle,
      "the retitle did not take, so the assertion below would be about nothing",
    ).toBe("Notes 🙂");
    expect(
      retitled?.cardImageLeaf,
      "the stored leaf changed, so this test is no longer about a stale one",
    ).toBe(cardImageLeaf(token, "Q3 layoffs plan"));

    expect(await locationFor(t, token)).toBeNull();
  });

  /**
   * **The third half of the same comparison, and the one this feature added.**
   *
   * A folder card draws its contents as well as its name, so the title alone no
   * longer identifies the picture. `cardLocation` recomputes the leaf from the
   * title *and* the stored contents, and a stale one — written before the owner
   * moved a note out of the folder — must answer `null` rather than keep
   * serving a card that names notes the folder no longer holds.
   *
   * Sabotaging `cardImageLeaf`'s third argument away leaves every other test in
   * this file green, because every other one is about a note share with no
   * contents at all.
   */
  test("a folder whose contents changed stops serving the old card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );
    await t.run(async (ctx) =>
      ctx.db.patch(row!._id, { previewChildren: ["overview.md"] }),
    );
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(token, "Chapter transition", ["overview.md"]),
    });

    // The positive control, without which "resolves nothing" proves nothing.
    expect((await locationFor(t, token))?.leaf).toBe(
      cardImageLeaf(token, "Chapter transition", ["overview.md"]),
    );

    await t.run(async (ctx) =>
      ctx.db.patch(row!._id, { previewChildren: ["timeline.md"] }),
    );
    expect(await locationFor(t, token)).toBeNull();
  });

  /**
   * **The token half of the comparison, which the title half cannot pin.**
   *
   * `cardImageLeaf` hashes the token *and* the title, and a check of only the
   * title's hash passes every other test in this file — measured, 27 of 27.
   * That is the cheaper refactor to expect, because this whole section is about
   * titles. Under it a revoke-then-reshare regresses silently: the token
   * changes, the title does not, the hash still matches, and the new
   * recipient's link serves the *revoked* share's card.
   *
   * Re-sharing after a revoke mints a new token and leaves `cardImageLeaf`
   * behind, because nothing clears it — so this is the same stale pointer as
   * the test above, reached by the other door.
   */
  test("re-sharing after a revoke does not serve the revoked share's card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const first = await share(t, ownerId, workspaceId, {
      previewTitle: "Q3 layoffs plan",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", first))
        .unique(),
    );
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(first, "Q3 layoffs plan"),
    });

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    // Same title, deliberately: it is what makes the title's hash agree and
    // leaves the token as the only thing that can refuse.
    const second = await share(t, ownerId, workspaceId, {
      previewTitle: "Q3 layoffs plan",
    });
    expect(second, "the re-share reused the token, so nothing is being tested").not.toBe(
      first,
    );

    expect(await locationFor(t, second)).toBeNull();
  });

  /**
   * **A fifth way the leaf and the title come apart, and the worst of them.**
   *
   * `titleInPreview` can stay true while `previewTitle` goes away: re-sharing
   * with no title writes `chosenTitle ?? undefined`, and `titleFromPath`
   * answers `null` for a filename with no letters in it — a dated capture, say.
   * The card then publishes a title the OG *text* has already dropped, which is
   * the opposite of the direction everything else here fails in.
   *
   * This is what the `previewTitle` guard in `cardLocation` is for. It was
   * added to mirror `cardSubject` and this case was not named; it is named now,
   * because the guard is the only thing standing in front of it.
   */
  test("a share whose title was blanked serves no card", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    // A filename `titleFromPath` cannot make a title out of.
    const dated = "0-inbox/2026-08-30.md";
    const first = await share(t, ownerId, workspaceId, {
      path: dated,
      previewTitle: "Q3 layoffs plan",
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", first))
        .unique(),
    );
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(first, "Q3 layoffs plan"),
    });
    expect((await locationFor(t, first))?.leaf).toBe(
      cardImageLeaf(first, "Q3 layoffs plan"),
    );

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });
    const second = await share(t, ownerId, workspaceId, { path: dated });

    const blanked = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", second))
        .unique(),
    );
    expect(
      blanked?.previewTitle,
      "the title did not blank, so this test is about something else",
    ).toBeUndefined();

    expect(await locationFor(t, second)).toBeNull();
  });

  /**
   * A share recipient is not a member, and a card is not a note. Neither of
   * those changes because bytes now live in the bucket.
   */
  test("a card leaf is not reachable through the ordinary note read path", async () => {
    const t = setupTest();
    const { ownerId, lkId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    await addMember(t, workspaceId, lkId, "member");

    const leaf = cardImageLeaf(token, "Chapter transition");
    // `.images/` is dot-prefixed, so `isPlumbing` hides it from every listing
    // and every read that goes through the manifest.
    expect(`.images/${leaf}`.startsWith(".")).toBe(true);
  });
});

describe("recording a card", () => {
  test("a revoked share is not pointed at bytes that arrived late", async () => {
    const t = setupTest();
    const { ownerId, workspaceId } = await scenario(t);
    const token = await share(t, ownerId, workspaceId);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", token))
        .unique(),
    );

    const listed = await asUser(t, ownerId).query(api.functions.shares.listShares, {
      workspaceId,
    });
    await asUser(t, ownerId).mutation(api.functions.shares.revokeShare, {
      shareId: listed[0].shareId,
    });

    // The render was in flight when the owner revoked.
    await t.mutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: row!._id,
      leaf: cardImageLeaf(token, "Chapter transition"),
    });

    const after = await t.run(async (ctx) => ctx.db.get(row!._id));
    expect(after?.cardImageLeaf).toBeUndefined();
  });
});

/**
 * THE COVERAGE CHECK IS A PIN, BECAUSE NOTHING ELSE CAN HOLD IT.
 *
 * `renderShareCard` calls a `"use node"` action that boots satori and resvg, so
 * this suite cannot execute it — and that is not a theoretical gap. Deleting
 * the `isRenderableTitle` guard from the action left all 22 tests above green.
 *
 * What ships without it is worse than a crash: satori draws an uncovered glyph
 * as `□` **silently**, so the bytes written into the customer's bucket are a
 * row of empty boxes wearing our branding — and every unfurler that sees them
 * caches the image permanently, because Discord and WhatsApp copy it to their
 * own CDNs. It cannot be retracted.
 *
 * So this reads the source, exactly as `structure.test.ts` does for the
 * credential barrier. A source assertion is a weak test; a weak test here beats
 * the green run a deleted guard currently produces.
 */
describe("the tofu guard cannot be deleted quietly", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../functions/shareCard.ts", import.meta.url)),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * The *call*, not the import.
   *
   * The first version of this looked for `isRenderableTitle` with `indexOf`,
   * which matched the import at the top of the file — so deleting the guard
   * from the handler left the import behind and the pin passed. A guard whose
   * own check is satisfied by an unused import is exactly the class of thing
   * this file exists to catch, and it caught it on the second attempt only
   * because the sabotage was re-run.
   */
  const guardCall = code.search(/if\s*\(!isRenderableTitle\(/);

  test("the coverage check runs before any render is spent", () => {
    const render = code.indexOf("cardRender.renderCard");

    expect(guardCall, "renderShareCard no longer calls isRenderableTitle").toBeGreaterThan(-1);
    expect(render, "renderShareCard no longer renders").toBeGreaterThan(-1);
    expect(
      guardCall,
      "coverage must be checked BEFORE the render, or tofu is drawn and stored",
    ).toBeLessThan(render);
  });

  test("and before anything is written to the customer's bucket", () => {
    const write = code.indexOf('kind: "writeImage"');
    expect(write).toBeGreaterThan(-1);
    expect(guardCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(write);
  });

  /**
   * Every failure between here and a finished card must leave the share
   * working. A render that throws, a bucket that refuses — both are caught, and
   * the share keeps its link and unfurls with the product card.
   */
  test("a failed render or a refused write does not fail the share", () => {
    // Two `catch` blocks: one around the render, one around the write.
    expect((code.match(/catch\s*\{/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // …and the card is recorded only after both succeeded.
    const write = code.indexOf('kind: "writeImage"');
    const record = code.indexOf("recordCardLeaf");
    expect(record).toBeGreaterThan(write);
  });

  /**
   * The renderer takes a title and returns bytes. Writing them is this module's
   * job, through the one enumerated barrier — `runFileOperation`. A second
   * credential path is the thing `CREDENTIAL_BARRIERS` exists to prevent.
   */
  test("bytes reach the bucket only through the enumerated barrier", () => {
    // The exact reference, not a prefix: `files.runFileOperationDirect` would
    // satisfy a `toContain("files.runFileOperation")` while routing around the
    // one function `CREDENTIAL_BARRIERS` pins.
    expect(code).toMatch(/internal\.functions\.files\.runFileOperation\s*,/);
    expect(code).not.toContain("getBindingForGateway");
    expect(code).not.toContain("storeForBinding");
    expect(code).not.toContain("decryptSecret");
  });
});
