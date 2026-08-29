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
export function shareUrl(token: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}${SHARE_PATH_PREFIX}${token}`;
}

/**
 * What the owner is told a share does, named after the note.
 *
 * One sentence, and it states the traversal rule outright. The alternative —
 * "Share this note" — is shorter and describes a grant the reader would guess
 * wrong in the direction that matters, because "and the notes it links to" is
 * the part nobody expects.
 */
export function describeShare(): string {
  return (
    "They sign in to read it, and can open this note and the notes it links to — " +
    "nothing else in your context."
  );
}

/**
 * The consequence of leaving the preview title on, in the words it costs.
 *
 * Named after the title that would actually appear, because "may expose
 * metadata" is a sentence nobody weighs. `previewTitle` is what the card will
 * say; if there is none, the honest version says so.
 */
export function describePreviewTitle(previewTitle: string | undefined): string {
  return previewTitle === undefined
    ? "Anyone with the link sees the note's name before signing in."
    : `Anyone with the link sees “${previewTitle}” before signing in.`;
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
