/**
 * A share's card image, in the owner's own bucket.
 *
 * ## Why the bucket and not our storage
 *
 * A card is derived from a note the customer wrote, so it lives where that note
 * lives. That is non-negotiable #1 read literally rather than narrowly: their
 * bytes, their storage, and **revoking our credential takes the previews with
 * it** — which is the product's promise working, not a cost of it. The owner
 * decided this explicitly when the alternative was paying for edge rendering.
 *
 * ## The shape, and why it is a pre-render
 *
 * The card is drawn once, when a share is created or its title changes, and
 * written to `.images/`. Nothing renders on an unfurl. That matters because the
 * render is 370–560 ms warm in Convex against ~25 ms at the edge — fine for a
 * mutation somebody is watching, far too slow for a crawler that will time out.
 *
 * Every step is allowed to fail without failing the share:
 *
 *  - The renderer is unavailable → no `cardImageLeaf`, static product card.
 *  - The title has a glyph the font cannot draw → no leaf, static card. Drawing
 *    it anyway would ship `□□□` onto a card unfurlers cache forever.
 *  - The bucket refuses the write → no leaf, static card.
 *
 * A share with no card is a share that works. A share that failed to be created
 * because a *picture* failed is not, which is why none of this is in the
 * critical path of `createShare`.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { cardImageLeaf } from "./lib/cardKey";
import { isRenderableTitle } from "./lib/cardCoverage";
import { boundPreviewChildren, previewChildrenFrom } from "./lib/shareTitle";

/**
 * Draw a share's card and put it in the owner's bucket.
 *
 * Scheduled, never awaited: `ctx.scheduler.runAfter` enqueues in a separate
 * transaction whose return value is discarded, so a slow or failing render
 * cannot make `createShare` slow, fail, or observably different. The same
 * "scheduling is not calling" rule the invitation mail follows, and for the
 * same reason — the caller must learn nothing from it.
 */
export const renderShareCard = internalAction({
  args: { shareId: v.id("noteShares") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const share = await ctx.runQuery(internal.functions.shareCard.cardSubject, {
      shareId: args.shareId,
    });
    // Revoked, deleted, or the title switched off between scheduling and now.
    if (share === null) return null;

    // **The listing happens here, before the renderability check, and that
    // order is deliberate.** These names go into the link's *description* as
    // well as into the picture, so a title the bundled font cannot draw must
    // not silently cost the folder its listing as well as its card.
    const children = await snapshotChildren(ctx, args.shareId, share);

    // Checked before spending a render, and before writing bytes nobody should
    // see: satori draws an uncovered glyph as tofu rather than failing, so a
    // card for a title the bundled font cannot draw is a broken image that
    // every unfurler then caches permanently.
    if (!isRenderableTitle(share.title)) return null;

    let bytes: ArrayBuffer;
    try {
      bytes = await ctx.runAction(internal.functions.cardRender.renderCard, {
        title: share.title,
        // **Filtered for the picture only, never for the stored list.** A child
        // the font cannot draw is dropped from the image — the same refusal the
        // title gets, for the same tofu — while the description keeps naming
        // it, because text has no coverage problem. The two are allowed to
        // differ here and nowhere else: the object's name is computed from the
        // stored list on both sides, so the cache key cannot drift.
        children: children.filter((name) => isRenderableTitle(name)),
      });
    } catch {
      // A missing wasm install, or a renderer that threw. The share keeps
      // working and unfurls with the product card.
      return null;
    }

    const leaf = cardImageLeaf(share.token, share.title, children);

    try {
      await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: share.workspaceId,
        // `team`, not `private`, and it is not consulted for an image write —
        // passed because the barrier's signature requires a scope. An object in
        // `.images/` has no visibility of its own.
        scope: "team",
        operation: { kind: "writeImage", leaf, bytes, contentType: "image/png" },
      });
    } catch {
      // No bucket, a revoked key, a refused write. All the same outcome.
      return null;
    }

    await ctx.runMutation(internal.functions.shareCard.recordCardLeaf, {
      shareId: args.shareId,
      leaf,
    });
    return null;
  },
});

/**
 * What a card needs, or `null` if there should not be one.
 *
 * INTERNAL, and the `null` covers revoked, expired, deleted, title switched
 * off, and no title at all — every state in which the answer is "serve the
 * static card". Collapsing them here means the action has one branch instead of
 * five.
 */
export const cardSubject = internalQuery({
  args: { shareId: v.id("noteShares") },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      token: v.string(),
      title: v.string(),
      /** What to list, for a folder link. Never returned to anybody but the action. */
      entryPath: v.string(),
      /**
       * Whether this is a **team** link.
       *
       * Only a team link is reachable by `previewForNote`, which is the one
       * place a child listing is ever published — so a personal share must not
       * spend a listing on the customer's bucket to store names nothing will
       * ever read.
       */
      teamLink: v.boolean(),
      /** What is stored now, so a listing that fails leaves it standing. */
      children: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const share = await ctx.db.get(args.shareId);
    if (share === null || share.status !== "active") return null;
    if (share.expiresAt !== undefined && share.expiresAt <= Date.now()) return null;
    if (!share.titleInPreview) return null;
    if (share.previewTitle === undefined || share.previewTitle.trim() === "") return null;

    return {
      workspaceId: share.workspaceId,
      token: share.token,
      title: share.previewTitle,
      entryPath: share.entryPath,
      teamLink: share.recipientKind === "members",
      children: boundPreviewChildren(share.previewChildren ?? []),
    };
  },
});

/**
 * Take the folder's listing, store it, and answer with what a card should draw.
 *
 * ## Absent is not empty, and the difference is the whole function
 *
 * A listing that **succeeds with nothing visible** is an answer: the owner made
 * everything in there private, and the stored list must be cleared or the card
 * keeps naming notes they took back. A listing that **fails** — no bucket, a
 * revoked key, a store that is down — knows nothing, and clearing on it would
 * let a flaky afternoon quietly strip the cards off every folder link in the
 * context. So the first records `[]` and the second leaves what stands, which
 * is the rule `recordVerification` follows for the note census one layer up.
 *
 * ## What it does not spend
 *
 * Nothing at all for a personal share, whose card is never reached by the
 * guessable address this list is published to. That one is a guard, and it is
 * tested: `checkSharePath` already refuses a personal share over anything but a
 * `.md` path, so it cannot be reached through the API — the test patches the
 * row, because the version that created one through `createShare` stayed green
 * when the line was deleted.
 *
 * And nothing for a `.md` path, which cannot have children. **That one is a
 * cost and not a guard, and is labelled so rather than left to read as one:**
 * deleting it leaves the whole suite green — measured — because a listing of a
 * note returns nothing anyway. What it buys is that the common case, a team
 * link to a note, is exactly as cheap as it was before this feature existed. A
 * folder somebody named `notes.md` gets no contents, which is the same answer
 * an empty folder gets.
 */
async function snapshotChildren(
  ctx: ActionCtx,
  shareId: Id<"noteShares">,
  share: {
    workspaceId: Id<"workspaces">;
    entryPath: string;
    teamLink: boolean;
    children: string[];
  },
): Promise<string[]> {
  if (!share.teamLink) return [];
  if (share.entryPath.toLowerCase().endsWith(".md")) return [];

  let children: string[];
  try {
    const listing = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: share.workspaceId,
      // **`team`, and it is the security boundary rather than a formality.**
      // `listFolder` runs `canSee` and `folderVisibleAtScope` at this scope, so
      // a private note and a private subfolder are gone before anything here
      // sees them. `private` would put the owner's own hidden notes on a card
      // served to an anonymous crawler.
      scope: "team",
      operation: { kind: "list", path: share.entryPath },
    });
    if (listing.kind !== "listing") return share.children;
    children = previewChildrenFrom(listing.entries);
  } catch {
    // Knows nothing. Leave whatever is stored standing.
    return share.children;
  }

  await ctx.runMutation(internal.functions.shareCard.recordPreviewChildren, {
    shareId,
    children,
  });
  return children;
}

/** Store what a folder link's card names. Bounded again on the way in. */
export const recordPreviewChildren = internalMutation({
  args: { shareId: v.id("noteShares"), children: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const share = await ctx.db.get(args.shareId);
    // Revoked while the listing was in flight.
    if (share === null || share.status !== "active") return null;
    const bounded = boundPreviewChildren(args.children);
    await ctx.db.patch(args.shareId, {
      // `undefined` rather than `[]` for "nothing", so one absence has one
      // representation on the row the way it has one in every answer built
      // from it.
      previewChildren: bounded.length === 0 ? undefined : bounded,
    });
    return null;
  },
});

/** Point the share at its card. Only ever called after the bytes landed. */
export const recordCardLeaf = internalMutation({
  args: { shareId: v.id("noteShares"), leaf: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const share = await ctx.db.get(args.shareId);
    // Revoked while the render was in flight. The bytes are already in the
    // customer's bucket and are deliberately left there — the images feature's
    // rule is that nothing here ever collects, because we cannot see what
    // Obsidian or rclone did to that bucket in the meantime. What matters is
    // that no *row* points at it, so nothing serves it.
    if (share === null || share.status !== "active") return null;
    await ctx.db.patch(args.shareId, { cardImageLeaf: args.leaf });
    return null;
  },
});

/**
 * The card's bytes for a token. NO SESSION.
 *
 * The second unauthenticated function in this product, beside
 * `previewTitleForToken`, and it discloses strictly less: that one returns a
 * title, this returns a picture of the same title. Everything the
 * `UNAUTHENTICATED_HTTP_ROUTES` comment says about the first applies unchanged.
 *
 * `null` for every absence — unknown token, revoked, expired, title off, never
 * rendered, bucket unreachable — so a crawler cannot tell a share that was
 * taken back from one that never existed. The caller serves the static product
 * card for all of them.
 *
 * **This reads a customer's bucket for an anonymous caller**, which is worth
 * stating plainly. What bounds it: the caller must present a 64-character token
 * from `crypto.getRandomValues` that the owner handed out; the key it can reach
 * is computed here from that token, never supplied; and the router caches the
 * result, so a card is fetched about once rather than once per unfurl.
 */
export const cardBytesForToken = internalAction({
  args: { token: v.string() },
  returns: v.union(v.null(), v.bytes()),
  handler: async (ctx, args): Promise<ArrayBuffer | null> => {
    const card = await ctx.runQuery(internal.functions.shareCard.cardLocation, {
      token: args.token,
    });
    if (card === null) return null;

    try {
      const result = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: card.workspaceId,
        scope: "team",
        operation: { kind: "readImage", leaf: card.leaf },
      });
      return result.kind === "image" ? result.bytes : null;
    } catch {
      // A deleted object, a revoked bucket key, a store that is down. The card
      // is unavailable, which is the same answer as never having had one.
      return null;
    }
  },
});

/** Where a live share's card lives, or `null`. Never says which reason. */
export const cardLocation = internalQuery({
  args: { token: v.string() },
  returns: v.union(
    v.null(),
    v.object({ workspaceId: v.id("workspaces"), leaf: v.string() }),
  ),
  handler: async (ctx, args) => {
    const share = await ctx.db
      .query("noteShares")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (share === null || share.status !== "active") return null;
    if (share.expiresAt !== undefined && share.expiresAt <= Date.now()) return null;
    if (!share.titleInPreview) return null;
    if (share.cardImageLeaf === undefined) return null;

    /**
     * **The stored leaf is the hash of whatever title was current at the last
     * SUCCESSFUL render, which is not the same as the title now.**
     *
     * `renderShareCard` returns early — leaving the old leaf in place, because
     * nothing anywhere clears this field — for a title the bundled font cannot
     * draw, for a renderer that threw, and for a bucket that refused the write.
     * A revoke-then-reshare mints a new token and leaves it too. In every one
     * of those the OG *text* updates while the OG *image* keeps publishing the
     * title the owner replaced, and the card is the one thing here that cannot
     * be taken back: Discord and WhatsApp copy it to their own CDNs, iMessage
     * bakes it into the sent message, Facebook caches by URL.
     *
     * So the leaf is recomputed rather than trusted. The mismatch answers
     * `null`, which is the same absence a share with no card yet gives — the
     * whole point of these all being one absence is that a crawler cannot tell
     * them apart.
     *
     * `previewTitle` is checked the way `cardSubject` checks it, because the
     * comparison is only meaningful against the string a render would have been
     * handed.
     */
    if (share.previewTitle === undefined || share.previewTitle.trim() === "") return null;
    if (
      share.cardImageLeaf !==
      cardImageLeaf(
        share.token,
        share.previewTitle,
        boundPreviewChildren(share.previewChildren ?? []),
      )
    ) {
      return null;
    }

    return { workspaceId: share.workspaceId, leaf: share.cardImageLeaf };
  },
});

/**
 * Schedule a card for a share. Called by `createShare`.
 *
 * A helper rather than an inline `runAfter` so there is one place that decides
 * the delay, and so the scheduling cannot drift between the create path and the
 * retitle path.
 */
export async function scheduleCardRender(
  ctx: MutationCtx,
  shareId: Id<"noteShares">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.functions.shareCard.renderShareCard, {
    shareId,
  });
}
