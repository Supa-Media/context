/**
 * The refusals a share raises, each worded for the one person who sees it.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function;
 * this module registers none. Every authorization refusal on the read path is
 * `shareUnavailable()`, laundered through `anonymousSafe` for a caller with
 * no session — see both comments before adding a new shape.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";

/**
 * A folder an unlisted link may not be minted over.
 *
 * Its own code beside `PATH_NOT_TEAM_VISIBLE`, worded for the thing the owner
 * is actually looking at: "share the folder with your team first" is the action,
 * and naming a folder rather than a note is what stops them hunting for a note
 * that is not the problem.
 */
export function notTeamVisibleFolder(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "PATH_NOT_TEAM_VISIBLE",
    message:
      "Your team cannot read anything in that folder, so a link cannot either. " +
      "Share the folder with your team first, then make the link.",
  });
}

/**
 * A note an unlisted link may not be minted over, because its readers could not
 * see it anyway.
 *
 * Distinct from `PATH_NOT_SHAREABLE`, which is about paths no share may ever
 * cover whatever the manifest says. This one is a fact about the owner's own
 * `privacy.md` that they can change, so telling them apart is the difference
 * between "fix your path" and "publish the note first".
 *
 * It discloses nothing: the caller is the owner, who can read their own
 * manifest, and it is reachable only after owner clearance.
 */
export function notTeamVisible(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "PATH_NOT_TEAM_VISIBLE",
    message:
      "Your team cannot read that note, so a link cannot either. Check the path, " +
      "and share it with your team before making a link anyone can open.",
  });
}

/**
 * A note an unlisted link may not be minted over, because it is encrypted.
 *
 * Its own code rather than `PATH_NOT_TEAM_VISIBLE`: the two mean opposite
 * things to the owner holding the button. That one says "publish the note
 * first"; this one says "this note is deliberately unreadable, and a link
 * anyone can open is the one audience that cannot have it".
 *
 * It discloses nothing — the caller is the owner, past owner clearance, reading
 * a fact about their own note that its own frontmatter states in the clear.
 */
export function notLinkableEncrypted(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "PATH_ENCRYPTED",
    message:
      "That note is encrypted, so a link anyone can open cannot be made for it. " +
      "Turn off encryption for the note first, or share it with named people instead.",
  });
}

/**
 * One answer for every way a share read can fail to be authorized.
 *
 * Revoked, expired, never issued, addressed to somebody else, entry note
 * deleted, entry note no longer `team`-visible, target not linked from the
 * entry note — all of it is one sentence. Somebody holding a link who could
 * tell "the owner revoked this" from "the owner made it private" from "the note
 * moved" has learned three different things about a context they are not in.
 *
 * Deliberately NOT used for infrastructure failure. A bucket that is
 * unreachable is not an authorization answer, and reporting it as one would
 * tell a viewer their access was withdrawn when it was not — see
 * `readSharedNote`.
 */
export function shareUnavailable(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "SHARE_UNAVAILABLE",
    message: "This shared note is not available.",
  });
}

/**
 * The refusal a caller with no session gets, whatever they presented.
 *
 * `NOT_AUTHENTICATED` rather than `SHARE_UNAVAILABLE`, because "sign in" is
 * something the person can act on and it discloses nothing: they are being told
 * about their own session, not about the share. The viewer page sends them to
 * sign-in and back.
 *
 * It is raised only once the grant has failed to resolve, never before the
 * lookup — an unlisted link's whole premise is a reader who has no session and
 * needs none.
 */
export function notAuthenticated(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
}

/**
 * The refusal an anonymous caller may be shown, given the one we would raise.
 *
 * `shareUnavailable()` promises in its own doc comment that revoked, expired,
 * never issued, deleted and no-longer-`team`-visible are "all of it ... one
 * sentence". On the anonymous path they were two: the five that fail in
 * `authorizeShareRead` answered `NOT_AUTHENTICATED`, and the two that fail
 * *after* it — the note made private, the note gone from the bucket — answered
 * `SHARE_UNAVAILABLE`, because they are raised further down.
 *
 * That told a holder with no session which of the two kinds of withdrawal had
 * happened: revoking is invisible, making the note private was visible, and a
 * `SHARE_UNAVAILABLE` meant the row was still live and worth polling for the
 * moment the owner published again.
 *
 * A **signed-in** caller keeps `SHARE_UNAVAILABLE`. They have a name, so the
 * refusal is genuinely about the share rather than about their session, and
 * "sign in" is not something they can act on. This is the same split
 * `readSharedNote` already draws where the grant fails to resolve, applied to
 * the refusals raised after it.
 *
 * Infrastructure failure is deliberately NOT laundered through here — an
 * unreachable bucket is not an authorization answer, and reporting it as one
 * would tell a viewer their access was withdrawn when it was not. Only a
 * refusal this module raised is passed in, and `shareAnyone.test.ts` drives an
 * anonymous caller through both outage shapes so that boundary is a guard
 * rather than a sentence.
 *
 * ## Two residuals, stated rather than left to be rediscovered
 *
 * **The body is uniform; the latency is not.** Measured, for an anonymous
 * caller, all answering `NOT_AUTHENTICATED`: an invented or revoked token costs
 * **0** bucket round trips, a live row whose note was made private costs
 * **1**, and a live row whose note is gone costs **2**. So the distinction this
 * function removes from the response survives as timing, and a determined
 * holder can still learn that a row is live. Closing it means spending the same
 * reads on a token nobody minted, which is an unauthenticated caller choosing
 * how much of the customer's bucket quota to spend — the trade is not obviously
 * worth making, and it is not made here. Do not claim byte-indistinguishability
 * without this paragraph beside it.
 *
 * **The reader is sent to sign in for a note that will not be there.**
 * `NOT_AUTHENTICATED` routes the viewer to the sign-in screen, so a stranger
 * following an unlisted link whose note has since been made private is now
 * asked to create an account and *then* told it is unavailable — where before
 * they were told at once, and while the card they clicked may still say "no
 * account needed". That is the price of one uniform refusal, paid by the person
 * least able to understand it, and it is the right trade only because the
 * alternative tells them which kind of withdrawal happened.
 */
export function anonymousSafe(
  actorUserId: Id<"users"> | null,
  refusal: ConvexError<{ code: string; message: string }>,
): ConvexError<{ code: string; message: string }> {
  return actorUserId === null ? notAuthenticated() : refusal;
}
