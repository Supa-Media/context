/**
 * What an unfurl may learn with no session: a readable team link's card, and a
 * share token's title.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function
 * and wires these handlers to them; this module registers none. Adding a field
 * to either answer publishes it to the internet — read both comments first.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { QueryCtx } from "../../../_generated/server";
import { normalizePath } from "../fileOps";
import { findName } from "../nameClaims";
import { isProductMandatedPath } from "../scaffold";
import { isPlumbing } from "../privacy";
import { boundPreviewChildren } from "../shareTitle";
import { isLive } from "./standing";

export const previewForNoteArgs = { slug: v.string(), path: v.string() };

export const previewForNoteReturns = v.object({
  title: v.union(v.string(), v.null()),
  cardToken: v.union(v.string(), v.null()),
  /**
   * Two or three team-visible things inside a linked **folder**, or empty.
   *
   * Empty for every absence this query has, and for every folder with nothing
   * a `team` reader may see — so one absence still has one shape, and a
   * crawler cannot tell "revoked" from "never linked" from "all private" from
   * "a note rather than a folder".
   */
  children: v.array(v.string()),
});

/**
 * The title and card for a **readable** team link, for the edge router. NO
 * SESSION.
 *
 * `/console/@seyi?note=1-projects/plan.md` is the link an owner copies, because
 * a URL pasted into a document should say what it points at — a 64-character
 * token tells a reader nothing. That readability is the whole reason this
 * exists rather than the token lookup beside it.
 *
 * ## The oracle this opens, and what bounds it
 *
 * A console URL is **guessable**: anyone who knows the handle can type one. So
 * answering "what is this note called" to an unauthenticated crawler does let
 * somebody probe paths and learn which exist.
 *
 * What bounds it is that this answers **only for notes the owner has
 * explicitly team-linked** — pressing Copy link is what writes the row. A note
 * nobody has linked is byte-identical to a note that does not exist, so the
 * probe reveals the set the owner already chose to publish a card for, and
 * nothing about the rest of the context. The owner accepted that trade
 * deliberately, with the alternative (an unguessable token) in front of them,
 * because an unreadable link is one nobody clicks.
 *
 * Everything else the token lookup refuses, this refuses too: no owner, no
 * context name, no path, no dates, no counts, no listing. One field.
 *
 * `cardToken` is the team share's token, and it is safe to hand over here
 * **because a team share's token grants nothing** — reading is authorised by
 * membership on every request. It is a locator for the card image and not a
 * capability. This must never return a *personal* share's token, which is a
 * locator whose holder the owner chose; the query below only ever looks at
 * `members` rows.
 *
 * ## The folder's contents, and why they are on the row rather than in a bucket
 *
 * A link to a folder that unfurls as one word is barely better than the bare
 * branding it replaced, so a folder link also carries two or three of the
 * things inside it. Four properties hold that, and each is somewhere else:
 *
 *  - **They were filtered at `team` scope by the privacy engine**, in
 *    `snapshotChildren`, so a private note and a private subfolder never
 *    reached this row. Nothing counts what was dropped — a total over the
 *    folder rather than over the visible set is an existence oracle by
 *    subtraction.
 *  - **This query still reads no bucket.** It is a `query`; it cannot. The
 *    listing was taken once, when the owner made or refreshed the link, for the
 *    reason `lib/shareTitle.ts` refuses to read a title from a note: an unfurl
 *    is an anonymous, uncontrolled, endlessly-retried request, and making one
 *    spend a LIST against the customer's own bucket is not a cost they agreed
 *    to. `__tests__/sharePreview.test.ts` proves a preview resolves with no
 *    storage connected at all, which is what keeps this from regressing
 *    quietly.
 *  - **It is a listing, never a body.** Keys are metadata, the way a path is;
 *    a body would be the thing non-negotiable #1 keeps out of the control
 *    plane.
 *  - **Empty is the same answer as every other absence.** A note, an empty
 *    folder, a folder whose contents are all private, and a revoked link all
 *    return `[]`.
 */
export async function previewForNoteHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof previewForNoteArgs>,
) {
  const nothing = { title: null, cardToken: null, children: [] };

  const name = await findName(ctx, args.slug.replace(/^@/, "").toLowerCase());
  if (name?.workspaceId === undefined) return nothing;

  // **The rule is guessability, and it is not "files yes, folders no".**
  //
  // This query is unauthenticated. What licenses it answering at all is the
  // rule in CLAUDE.md that a card may carry a title where the address is not
  // guessable — `/s/<64 hex>` is 32 random bytes the owner handed to one
  // person, so "the requester may not have been meant to have this URL" does
  // not hold. A team link is `/@name/path`, which IS guessable, and the
  // decision survived that only because the probe space was names the owner
  // chose.
  //
  // Folders were refused wholesale for a real reason: `applyStructure` writes
  // `0-inbox`, `1-projects`, `2-areas`, `3-resources` and `4-archive` into
  // every workspace this product creates, so five guesses per handle were enough
  // to learn which of them their owner had team-linked, and to be handed its
  // title and a live token, unauthenticated.
  //
  // But that is an argument about **those five names**, not about folders.
  // `1-projects/public-worship-chapter-transition-and-people-system` is no
  // more guessable than a note filename, and refusing it cost a card for
  // nothing — which is the whole reason an owner links a folder at all. So
  // the five names moved into `isProductMandatedPath`, beside the six
  // filenames that were already there for exactly the same reason, and the
  // category rule is gone.
  //
  // Stated precisely, because an earlier version of this comment overstated
  // the leak: a live `noteShares` row is still required below, so this was
  // never a bare handle-existence oracle. What it published was which of a
  // workspace's scaffolded paths its owner had team-linked.
  const path = normalizePath(args.path);
  if (path === null || isPlumbing(path)) return nothing;

  // **One list, and it is the whole rule now.**
  //
  // `isProductMandatedPath` names every path this product writes, which is
  // more than what a fresh workspace arrives with: the five PARA folders,
  // `index.md`, `privacy.md`, a `README.md` in each folder and `todo.md` at
  // the root — plus the folders the gateway creates LATER, where
  // `save_context` files a session and where a capture lands under its
  // sender's slug. Those are guessable without
  // knowing anything about the owner, so they get the frozen card whether
  // they are a file or a folder.
  //
  // Anything else is a name the owner chose, which is the premise the whole
  // preview rests on — and it is as true of `1-projects/chapter-transition`
  // as it is of `1-projects/chapter-transition/overview.md`.
  if (isProductMandatedPath(path)) return nothing;

  const share = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_entry_recipient", (q) =>
      q
        .eq("workspaceId", name.workspaceId!)
        .eq("entryPath", path)
        .eq("recipientKind", "members")
        .eq("recipient", ""),
    )
    .unique();

  // Not linked, revoked, expired, or its title switched off — one answer, so
  // a crawler cannot tell "the owner took this back" from "never linked".
  if (share === null || !isLive(share, Date.now())) return nothing;
  if (!share.titleInPreview) return nothing;
  if (share.previewTitle === undefined) return nothing;

  return {
    title: share.previewTitle,
    cardToken: share.token,
    // **Bounded again on the way out, over a value this deployment wrote.**
    // Not paranoia about the row: the names in it came out of a bucket we do
    // not own, through a listing that may have run under an older bound, and
    // this is the last code that touches them before they are served to an
    // anonymous reader. The title is bounded twice for the same reason, and
    // the router bounds both a third time.
    children: boundPreviewChildren(share.previewChildren ?? []),
  };
}

export const previewTitleForTokenArgs = { token: v.string() };

export const previewTitleForTokenReturns = v.object({
  title: v.union(v.string(), v.null()),
  /**
   * Whether the card should say a reader must sign in.
   *
   * **The second field on this route, and it was argued for rather than
   * added.** The card's description has always read "Sign in to read it",
   * which was true of every share there was. It is false of an unlisted
   * link, and a card that tells somebody to sign in when they need no
   * account is the product being wrong on the one surface a stranger sees
   * first — the exact failure the frozen card exists to avoid, arrived at
   * from the other direction.
   *
   * It discloses nothing a crawler could not learn by following the link it
   * already holds, which is the test every field on an unauthenticated route
   * has to pass. And it is `false` for **every absence**, so an unknown,
   * revoked, expired or title-less share is one byte-identical answer rather
   * than two — the rule this route exists under, now over a tuple instead of
   * a single value.
   */
  openToAnyone: v.boolean(),
});

/**
 * The title a share's link unfurls with, for the edge router. NO SESSION.
 *
 * This is the only function in this product that returns anything derived from
 * a workspace to an unauthenticated caller, so the reasoning is written down
 * rather than assumed.
 *
 * ## Why it may exist at all
 *
 * `infra/router/src/preview.ts` freezes every name-bearing path to one card,
 * because `/@seyi` is **guessable** and a nicer preview would be an existence
 * oracle for usernames. A share URL is not guessable: it carries 32 bytes from
 * `crypto.getRandomValues` that the owner deliberately handed to somebody. The
 * rule the frozen card protects is intact; this is a different input.
 *
 * The trade was made explicitly by the product owner and is worth restating
 * because it is a real cost: **anybody holding the URL learns the title without
 * signing in** — everyone in the Slack channel it was pasted into, everyone on
 * the email thread, and the corporate link scanner that follows it. That is the
 * price of a link people will actually click, and it is per-share revocable
 * (`titleInPreview`) — for *future* crawls. A card that has already
 * been unfurled cannot be retracted: Discord and WhatsApp copy the image to
 * their own CDNs, and iMessage bakes it into the sent message. Treat anything
 * that reaches a card as permanently public.
 *
 * ## What holds the line
 *
 *  - **The title is never note content.** It is owner-chosen or derived from
 *    the filename, so an unfurl never reads the customer's bucket. See
 *    `lib/shareTitle.ts`. It is also **stored at share time**, so revoking and
 *    expiring freeze the card and making the note private does not: the read
 *    path re-checks the live manifest on every request, this does not, and it
 *    has nothing to re-check against. Revocation is the control here.
 *  - **One shape, always.** Unknown token, revoked share, expired share,
 *    `titleInPreview` off, a share whose title normalised to nothing — every
 *    one of them is `{ title: null }`. A crawler cannot tell revoked from
 *    never-issued, which is what stops an unfurl from reporting that an owner
 *    has acted.
 *  - **Nothing else is returned.** Not the workspace, the slug, the owner, the
 *    path, the recipient, or the dates. Adding a field here publishes it to the
 *    internet.
 *
 * ## What does not hold the line, and is not claimed to
 *
 * Timing. One indexed lookup happens either way, so the difference is small,
 * but this is not constant-time and should not be described as such. It is
 * acceptable for the reason `resolveInvitationForCaller` gives about its own
 * asymmetry: reaching a live row at all requires already holding a real token,
 * and somebody who holds one learns nothing from how long the answer took.
 */
export async function previewTitleForTokenHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof previewTitleForTokenArgs>,
) {
  // One absence, spelled once. Every refusal below returns this exact
  // object, so a crawler cannot tell a share that was taken back from one
  // that never existed — including by the second field.
  const nothing = { title: null, openToAnyone: false };

  const share = await ctx.db
    .query("noteShares")
    .withIndex("by_token", (q) => q.eq("token", args.token))
    .unique();

  if (share === null) return nothing;
  if (!isLive(share, Date.now())) return nothing;
  if (!share.titleInPreview) return nothing;
  if (share.previewTitle === undefined) return nothing;

  return {
    title: share.previewTitle,
    openToAnyone: share.recipientKind === "anyone",
  };
}
