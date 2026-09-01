/**
 * Sharing one note with one person, from the console.
 *
 * The types and the pure parts. Everything that talks to Convex lives in
 * `useFileBrowser`, and everything that draws lives in `ShareDialog`; what is
 * here is the handful of decisions that are worth testing without either.
 *
 * ## What a share is, in one sentence the owner can act on
 *
 * The recipient can read **this note and the notes it links to**, and nothing
 * else in the context. That is the whole grant (`SHARE_TRAVERSAL_DEPTH` is 1 in
 * `functions/shares.ts`), and the dialog says it in those words rather than
 * offering a "Share" button whose reach the owner has to infer. A sharing
 * control people cannot predict is a sharing control they cannot use safely.
 */

// The link's shape is the viewer's, not a second copy of it: one function
// builds a segment and one reads it, so the console cannot mint a URL the page
// at the other end declines to parse.
import { shareSegment } from "../../share/share";

/**
 * One live share, as `listShares` returns it.
 *
 * Mirrors the validator in `apps/convex/functions/shares.ts`. Kept as a local
 * interface rather than imported from the generated API so this module — and
 * its tests — stay free of Convex, the same way `editor.ts` and `menu.ts` are.
 */
export interface NoteShare {
  shareId: string;
  /** The link. Owner-only, and `listShares` is owner-only. */
  token: string;
  /** Decorated for display: `@lk`, or a bare address. */
  recipient: string;
  /**
   * Which kind of audience `recipient` names.
   *
   * The discriminator rather than the sentence, because one of these rows is
   * not like the others: an `anyone` share's reader never signs in, so it is
   * what the lock control reads to know a note is published, and a list that
   * drew it like a person would be omitting the one thing about it that
   * matters.
   */
  audience: "name" | "email" | "members" | "anyone";
  entryPath: string;
  titleInPreview: boolean;
  previewTitle?: string;
  createdAt: number;
}

/**
 * Where a shared note lives.
 *
 * Must agree with `SHARE_PREFIX` in `infra/router/src/preview.ts`, which is
 * what decides whether a crawler gets the note's title or the frozen card. The
 * two are asserted equal in `__tests__/shareLink.test.ts` rather than trusted
 * to stay in step.
 */
export const SHARE_PATH_PREFIX = "/s/";

/**
 * The link to hand somebody.
 *
 * Absolute, and built from the origin the console is actually being served
 * from rather than a hardcoded `https://context.lc`. A self-hosted deployment
 * is a supported path in this product, and a Copy Link that pasted somebody
 * else's domain into a colleague's chat would be the least recoverable kind of
 * wrong — they would sign in to the wrong product to look for a note that is
 * not there.
 */
export function shareUrl(
  token: string,
  origin: string,
  /**
   * The note's own name, when the owner has left it on the card.
   *
   * Omitted — or passed with `titleInPreview` off — gives a bare-token URL.
   * That is not tidiness: switching the title off is the owner saying they do
   * not want this note named to somebody who has not opened it, and a slug in
   * the URL would put the name in front of every person the link is forwarded
   * to, which is a larger audience than the card's.
   */
  title?: string | null,
): string {
  return `${origin.replace(/\/+$/, "")}${SHARE_PATH_PREFIX}${shareSegment(token, title)}`;
}

/**
 * The link for one share row, with the readable half filled in from the row.
 *
 * The row is the authority on both halves — the token and whether the owner
 * left the title on — so the two cannot be assembled inconsistently by a
 * caller that has one and guesses the other.
 */
export function shareUrlFor(share: NoteShare, origin: string): string {
  return shareUrl(
    share.token,
    origin,
    share.titleInPreview ? share.previewTitle : undefined,
  );
}

/**
 * What the owner is told a share does, named after the note.
 *
 * One sentence, and it states the traversal rule outright. The alternative —
 * "Share this note" — is shorter and describes a grant the reader would guess
 * wrong in the direction that matters, because "and the notes it links to" is
 * the part nobody expects.
 */
/**
 * The consequence of leaving the preview title on, in the words it costs.
 *
 * Named after the title that would actually appear, because "may expose
 * metadata" is a sentence nobody weighs. `previewTitle` is what the card will
 * say; if there is none, the honest version says so.
 */
export function describePreviewTitle(
  previewTitle: string | undefined,
  audience: NoteShare["audience"],
): string {
  // "Before signing in" is the cost for every link whose reader signs in
  // *afterwards*. An unlisted link's reader never does, so the sentence would
  // be describing a step that does not happen — and the thing actually worth
  // saying about that row is not the title at all, it is that the note itself
  // is readable by whoever holds the URL.
  const when = audience === "anyone" ? "even without opening it" : "before signing in";
  return previewTitle === undefined
    ? `Anyone with the link sees the note's name ${when}.`
    : `Anyone with the link sees “${previewTitle}” ${when}.`;
}

/**
 * What a row in SHARED WITH grants, said in one line under its name.
 *
 * The list holds three different things that look alike — a person, a link for
 * people who already have access, and a link that needs no account at all — and
 * "Copy link / Revoke" beside each of them says nothing about which is which.
 * The third is the one somebody must not mistake for the second.
 */
export function describeShareRow(audience: NoteShare["audience"]): string {
  if (audience === "anyone") {
    return "Anyone who has this link can read the note. No sign-in, no account.";
  }
  if (audience === "members") {
    return "Only people you have already given access to. It grants nothing on its own.";
  }
  return "They sign in as themselves, and can read this note and the notes it links to.";
}

/**
 * Whether this row may be shared at all, and why not.
 *
 * Three refusals, and each is a different sentence because each has a different
 * fix. They mirror the server's own checks in `createShare` — the UI decides
 * whether a control *exists*, and the server decides whether the action is
 * *allowed*; neither is a substitute for the other.
 */
export type ShareEligibility =
  | { ok: true }
  | { ok: false; reason: string };

export function shareEligibility(options: {
  path: string;
  kind: "file" | "folder";
  readOnly: boolean;
}): ShareEligibility {
  if (options.kind === "folder") {
    return {
      ok: false,
      reason: "Folders cannot be shared yet — share a note inside it.",
    };
  }
  if (options.readOnly) {
    return {
      ok: false,
      reason: "This file is part of how your context works, not a note.",
    };
  }
  if (!options.path.toLowerCase().endsWith(".md")) {
    return { ok: false, reason: "Only a note can be shared." };
  }
  return { ok: true };
}

/**
 * The shares on one note, newest first.
 *
 * Sorted here rather than on the server: `listShares` returns a context's whole
 * set in index order, and which of them belong to the note currently open is a
 * question about what the dialog is showing.
 */
export function sharesFor(
  shares: readonly NoteShare[] | undefined,
  path: string,
): NoteShare[] | undefined {
  if (shares === undefined) return undefined;
  return shares
    .filter((share) => share.entryPath === path)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * What renaming, moving or archiving this note does to the links people hold.
 *
 * **It breaks them, silently, and nothing warned.** A share is stored against
 * `entryPath` (`apps/convex/functions/shares.ts`), and the file operations
 * never touch the `noteShares` table — so the path moves and the share is left
 * pointing at somewhere that no longer exists. The archive dialog even said
 * "Nothing is deleted", which is true of the bytes and false of the access.
 *
 * Returns `null` when there is nothing to say: no shares on this note, or the
 * list has not loaded. **A list that has not loaded is not "no shares"** — the
 * same distinction `sharesFor` draws by answering `undefined` — so it stays
 * quiet rather than promising there is nothing to lose.
 *
 * The verb is passed in because the three dialogs are three different sentences
 * and a generic "this action" is the wording nobody reads.
 */
export function sharesBreakingWarning(
  shares: readonly NoteShare[] | undefined,
  path: string,
  verb: "Renaming" | "Moving" | "Archiving",
): string | null {
  const live = sharesFor(shares, path);
  if (live === undefined || live.length === 0) return null;
  // An unlisted link is held by an unknown number of people — that is what it
  // is for — so counting rows and calling them "people" would be a number the
  // owner would read as the size of the audience. It is named rather than
  // counted, and the count covers the rest.
  const open = live.filter((share) => share.audience === "anyone").length;
  const addressed = live.length - open;
  const parts: string[] = [];
  if (addressed > 0) {
    parts.push(addressed === 1 ? "1 person holds a link" : `${addressed} people hold links`);
  }
  if (open > 0) parts.push("an unlisted link anyone can open points");
  const subject = parts.join(", and ");
  const breaks = live.length === 1 ? "it" : "them";
  return `${subject[0]!.toUpperCase()}${subject.slice(1)} to this note. ${verb} it breaks ${breaks} — a share follows the path, not the note.`;
}


/* -------------------------------------------------------------------------- *
 * Two kinds of link, and the difference is the whole thing
 * -------------------------------------------------------------------------- */

/**
 * What the team link is, in the words it costs.
 *
 * **It grants nothing.** It is an address for a note, and whoever opens it sees
 * it only if their membership already lets them — so it is the right link for
 * the people you have already given access to, and the wrong one for everybody
 * else. Remove somebody from the context and the same URL shows them nothing.
 *
 * That is also why it is safe to paste into a group chat where some readers are
 * members and some are not: the non-members get the same nothing they would get
 * by typing the URL themselves.
 */
export function describeTeamLink(): string {
  return (
    "Anyone you have given access to this context can open it. It grants " +
    "nothing on its own — remove someone and the link stops working for them."
  );
}

/**
 * …and what a personal share is for, said next to it.
 *
 * The distinction people get wrong is which one to reach for, so the dialog
 * names the *audience* rather than the mechanism: somebody who already has
 * access needs no share, and somebody who does not should not be made a member
 * of your whole context to read one note.
 */
export function describePersonalShare(): string {
  /*
    **All three facts, in one sentence.** There were two, one under the other,
    and the second (`describeShare`, now gone) said "they sign in to read it,
    and can open this note and the notes it links to — nothing else in your
    context" directly beneath a line that had just said the same. Two
    paragraphs making one point read as two points, and on a phone they pushed
    the controls below the fold.

    What could not be dropped with it is `sign in` — this file's header names
    it as one of the three things an owner guesses wrong, because "Share"
    everywhere else in software means a link anybody can open. So it is folded
    in rather than deleted: audience, sign-in, depth-one, revocable.
  */
  return (
    "For somebody who does not have access. They sign in, then get this note " +
    "and the notes it links to — nothing else — and you can take it back."
  );
}
