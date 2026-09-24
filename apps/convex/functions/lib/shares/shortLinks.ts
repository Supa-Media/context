/**
 * Short links: the same share row, reached by a name somebody can say.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function —
 * including `readShortLink`, which resolves a slug through
 * `shortLinkTokenHandler` and then reads exactly as a token does — and wires
 * these handlers to them; this module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { findName } from "../nameClaims";
import { cardImageLeaf, cardSignature, hashTitle } from "../cardKey";
import { shortLinkSlugFrom } from "../shareSlug";
import { boundPreviewChildren, normalizePreviewTitle } from "../shareTitle";
import { isLive } from "./standing";

export const shortLinkTokenArgs = { handle: v.string(), slug: v.string() };

export const shortLinkTokenReturns = v.union(v.string(), v.null());

/**
 * The token a short link names, or `null`. INTERNAL.
 *
 * **The token is never returned to a browser.** A caller who guessed a slug is
 * a caller the owner may not have meant, and handing them the bearer value of
 * an `anyone` share would let them keep it after the slug was released — a
 * capability outliving the address it was published at. So this is internal,
 * `readShortLink` below consumes it in the same request, and what the client
 * gets back is the note or a refusal, never the credential.
 *
 * Absence is uniform: an unclaimed handle, an unclaimed slug, a revoked row
 * and an expired one all answer `null`.
 */
export async function shortLinkTokenHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof shortLinkTokenArgs>,
) {
  const slug = shortLinkSlugFrom(args.slug.toLowerCase());
  if (slug === null) return null;

  const name = await findName(ctx, args.handle.replace(/^@/, "").toLowerCase());
  const workspaceId = name?.workspaceId;
  if (workspaceId === undefined) return null;

  const rows = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_slug", (q) =>
      q.eq("workspaceId", workspaceId).eq("slug", slug),
    )
    .collect();
  const now = Date.now();
  const live = rows.find((row) => row.status === "active" && isLive(row, now));
  return live?.token ?? null;
}

export const previewForShortLinkArgs = { handle: v.string(), slug: v.string() };

export const previewForShortLinkReturns = v.object({
  title: v.union(v.string(), v.null()),
  /**
   * An opaque digest of what the card draws, or `null` when there is no card.
   *
   * The edge cannot invalidate an image: the Workers Cache API is
   * per-datacenter and `cache.delete` purges one colo, so the only
   * invalidation there has ever been is a different URL. `shareCardPath`
   * gets that by hashing the title it already holds — and this route's
   * caller cannot, because a folder card draws two or three names from
   * inside the folder and **those names are not what a short link's preview
   * discloses**. Handing back the digest rather than the ingredients keeps
   * the cache correct without widening what a guessable address answers.
   */
  cardVersion: v.union(v.string(), v.null()),
});

/**
 * The card a short link unfurls with: a title, or nothing.
 *
 * ## Why a guessable address may carry a title here
 *
 * `Link previews reveal nothing about a context` still holds for every path it
 * was written about, and this is the same second rule `shareNotePreview`
 * already lives under: a card may name something when the probe space is one
 * the **owner** chose. `/@seyi/intake` is not `/@seyi/1-projects` — there is no
 * list of likely slugs, because a slug exists only where an owner typed it,
 * and `shortLinkSlugRejection` refuses every name this product writes so the
 * guessable ones cannot be claimed at all.
 *
 * It is also the whole point of the feature. A short link is for pasting into
 * a signature, a channel, a slide; a link that unfurls as bare branding does
 * not get clicked, and a share nobody opens is a share that did not happen.
 *
 * Everything the note-preview rule pays for, this pays too:
 *
 *  - **The title is never read from the note.** It is the row's own
 *    `previewTitle`, owner-chosen or derived from the filename, so no crawler
 *    ever causes a GET against the customer's bucket.
 *  - **Every absence is one absence.** Unknown handle, unclaimed slug, revoked
 *    row, expired row, title switched off, title that normalised to nothing —
 *    all `{ title: null }`, which renders the generic card byte for byte.
 *  - **The shape is checked before the lookup**, so hammering `/@name/<junk>`
 *    costs a regex.
 *
 * And it carries the cost that cannot be taken back, stated plainly because an
 * owner claiming a memorable name is the most likely person to forget it:
 * a card that has already unfurled somewhere is cached by the platform that
 * unfurled it, and revoking cannot reach it. Revocation is enforced at the
 * destination, where it is immediate and complete.
 */
export async function previewForShortLinkHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof previewForShortLinkArgs>,
) {
  const nothing = { title: null, cardVersion: null };

  const slug = shortLinkSlugFrom(args.slug.toLowerCase());
  if (slug === null) return nothing;

  const name = await findName(ctx, args.handle.replace(/^@/, "").toLowerCase());
  const workspaceId = name?.workspaceId;
  if (workspaceId === undefined) return nothing;

  const rows = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_slug", (q) =>
      q.eq("workspaceId", workspaceId).eq("slug", slug),
    )
    .collect();
  const now = Date.now();
  const live = rows.find((row) => row.status === "active" && isLive(row, now));
  if (live === undefined || live.titleInPreview !== true) return nothing;
  /*
   * **`anyone`, and only `anyone`.** `titleInPreview` defaults to `true` on
   * every row `createShare` writes as well, and those are addressed to a
   * `@name` or an email — named people, which is the whole of what `team`
   * means. That default was unreachable before there were short links: such a
   * row answered to its 64-hex token and nothing else, so no stranger could
   * ask for its title. A slug is an owner-chosen word at a guessable address,
   * and `setShareSlug` does not ask what the row's audience is, so the same
   * default became answerable with no session at all.
   *
   * Refused here rather than in `setShareSlug`, because a memorable address
   * for a link shared with named people is a reasonable thing to want and
   * still works — its readers sign in and `readSharedNote` authorises them
   * exactly as before. It is the *title* that must not travel to somebody who
   * is not on the list. A crawler's unfurl cannot be revoked once it is
   * cached, so this is decided in the direction that cannot be taken back.
   */
  if (live.recipientKind !== "anyone") return nothing;

  const title = normalizePreviewTitle(live.previewTitle ?? "");
  if (title === null) return nothing;
  /*
    A version only where there is a card to version. `null` is what tells the
    edge to fall back to the product's own image, so the absence has to
    survive every reason a card can be missing — never rendered, render
    failed, bucket refused, title changed since the last successful render —
    which is exactly the set `cardLocationForShortLink` refuses on. The leaf
    is recomputed there and compared for the same reason it is compared
    there: a stale card publishes a title its owner has already replaced.
  */
  const drawable =
    live.cardImageLeaf !== undefined &&
    live.previewTitle !== undefined &&
    live.cardImageLeaf ===
      cardImageLeaf(
        live.token,
        live.previewTitle,
        boundPreviewChildren(live.previewChildren ?? []),
      );
  return {
    title,
    cardVersion: drawable
      ? hashTitle(cardSignature(title, boundPreviewChildren(live.previewChildren ?? [])))
      : null,
  };
}
