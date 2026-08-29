/**
 * The title a shared link unfurls with.
 *
 * This is the one string in this product that is published to unauthenticated
 * readers, so what it may be derived from is a security decision rather than a
 * formatting one.
 *
 * ## Why it is not read from the note
 *
 * The obvious implementation takes the note's first heading. It is wrong twice
 * over. A crawler is unauthenticated and uncontrolled — every Slack unfurl,
 * every link scanner, every retry — so a title read from the note means an
 * anonymous request triggering a GET against **the customer's own bucket**, on
 * their quota, for a page nobody has signed in to. And a heading is note
 * *content*, which CLAUDE.md non-negotiable #1 keeps out of the control plane;
 * a path is metadata, and this is derived from the path.
 *
 * ## Why it defaults rather than being required
 *
 * `infra/router/src/preview.ts` already wrote the rule this follows: "one
 * field, and it is not a name the owner did not choose". An owner-typed label
 * satisfies that outright. A filename does too, and more quietly — the owner
 * chose `implementation-handoff.md`, nobody else did — so it is a safe default
 * that keeps the common case a single click instead of a form.
 *
 * The one thing neither may be is a *guess*. There is no fallback that invents
 * words: a path that yields nothing usable yields nothing, and the card falls
 * back to plain product branding.
 */

/**
 * The longest title that reaches a card.
 *
 * Mirrors the bound `previewFromProfile` applies in the router. It is not
 * cosmetic: the string ends up in an `og:title`, and an unbounded one would let
 * response size vary with something the owner types — and, on a shared context,
 * something an `editor` could set through a share they created.
 */
export const MAX_PREVIEW_TITLE = 60;

/**
 * A note's filename, as a human would write it.
 *
 * `1-projects/transition/implementation-handoff.md` → `Implementation handoff`.
 *
 * Separators become spaces, a leading PARA-style numeric prefix is dropped, and
 * only the first letter is capitalised — title-casing every word would turn
 * `q3-budget-for-lk` into something nobody wrote. Returns `null` when nothing
 * legible survives, because a card with no title is honest and a card titled
 * `2026 08 29` is noise.
 */
export function titleFromPath(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/i, "");
  const words = base
    .replace(/^\d+[-_.\s]+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (words === "") return null;
  // A name that is only digits and punctuation — a date-stamped capture, say —
  // is not a title. Better to show none than to show a filing code.
  if (!/[a-z]/i.test(words)) return null;
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(
    0,
    MAX_PREVIEW_TITLE,
  );
}

/**
 * Normalise a title the owner typed, or `null` if it is not usable.
 *
 * Control characters are stripped rather than escaped. They cannot break the
 * router's HTML — that escapes on the way out, and is tested — but a newline in
 * an `og:title` produces a card that renders differently across unfurlers, and
 * the fix belongs at the point the value is stored rather than at every point
 * it is read.
 */
export function normalizePreviewTitle(raw: string): string | null {
  const clean = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (clean === "") return null;
  return clean.slice(0, MAX_PREVIEW_TITLE);
}
