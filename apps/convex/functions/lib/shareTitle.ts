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
import type { Visibility } from "./privacy";

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

/* -------------------------------------------------------------------------- */
/* What a FOLDER link unfurls with, beside its name                            */
/* -------------------------------------------------------------------------- */

/**
 * How many children a folder's card may name.
 *
 * Three, because that is what makes the card useful — a folder link that
 * unfurls as a bare name is barely better than bare branding — and because a
 * card is a card: a fourth line does not fit under a 54px title, and every
 * extra name is one more thing published to whoever the URL reaches.
 *
 * **There is deliberately no `+N more`.** A count is the useful-looking
 * addition and it is the one this list must not grow. A total computed over the
 * *visible* set is safe; a total computed over the folder is an existence
 * oracle by subtraction — exactly what the console's note census is owner-only
 * to prevent, and what search computes its own totals from the visible list to
 * avoid. If a count is ever wanted here it must come from the same filtered
 * array these names come from, and from nowhere else.
 */
export const MAX_PREVIEW_CHILDREN = 3;

/**
 * The longest child name that reaches a card.
 *
 * Shorter than `MAX_PREVIEW_TITLE` on purpose: three of these sit under the
 * title, and the bound is what stops the response size — and the card's layout
 * — varying with a filename somebody chose. Bounded here and again in
 * `infra/router/src/preview.ts`, for the reason the title is: an edge that
 * trusts its upstream to have been careful has no bound at all.
 */
export const MAX_PREVIEW_CHILD_NAME = 40;

/**
 * Every control character, as one class.
 *
 * `\p{Cf}` is here beside `\p{Cc}` because the categories are disjoint and only
 * one of them was being stripped. U+202E RIGHT-TO-LEFT OVERRIDE, the U+2066
 * isolates and U+200B ZERO WIDTH SPACE are all `Cf`, and a bidi override in an
 * `og:description` reverses the rendering of everything after it in most
 * unfurlers — under this product's own branding, on a card CLAUDE.md says
 * cannot be retracted once cached. The writer need not be the owner: on a
 * shared workspace an editor creates the file and the owner links the folder.
 *
 * `\p{Cc}` rather than an explicit range: it is the Unicode category itself,
 * so it covers C1 (U+0080–U+009F) as well as C0 and DEL. `normalizePreviewTitle`
 * above predates this and names the range by hand; the two agree on everything
 * a title can contain, and this is the wider of the two.
 */
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/**
 * Normalise one child's display name, or `null` if nothing usable survives.
 *
 * The input is **a key out of a bucket we do not own**. Obsidian's sync plugin,
 * rclone and the provider's own console all write keys directly, so a filename
 * can carry a newline, a control character, or three hundred bytes of anything
 * — the same premise `writableAsRule` starts from when it refuses to treat a
 * bucket key as a manifest rule. Control characters are stripped rather than
 * escaped, at the point the value is taken rather than at every point it is
 * read, exactly as `normalizePreviewTitle` does: the router escapes on the way
 * out and is tested for it, but a newline inside an `og:description` renders
 * differently in every unfurler and there is nothing to escape it *to*.
 */
export function normalizePreviewChild(raw: string): string | null {
  const clean = raw.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (clean === "") return null;
  return clean.slice(0, MAX_PREVIEW_CHILD_NAME);
}

/**
 * Bound a child list, on the way in and again on the way out.
 *
 * Applied where the list is written *and* where it is read, for one reason:
 * what is stored came out of the customer's bucket, and a row written by an
 * older deployment — or by a listing that ran before a bound was tightened —
 * must not be able to widen a response served to an anonymous crawler. Same
 * shape as the title's double bound, same argument.
 */
export function boundPreviewChildren(raw: readonly string[]): string[] {
  const bounded: string[] = [];
  for (const entry of raw) {
    if (bounded.length >= MAX_PREVIEW_CHILDREN) break;
    const clean = normalizePreviewChild(entry);
    if (clean !== null) bounded.push(clean);
  }
  return bounded;
}

/**
 * The names a folder's card may carry, from a listing the privacy engine has
 * already filtered.
 *
 * **The filtering is not done here and must not be.** The argument is a
 * `listFolder` result taken at `team` scope, so `canSee` and
 * `folderVisibleAtScope` have already dropped every private note and every
 * private subfolder — one privacy engine, the same one the console and the
 * gateway read through, rather than a second predicate in the preview path
 * that could disagree with it. A second filter is a second place for a
 * visibility bug, which is the rule the two search dialects already follow.
 *
 * A folder child keeps a trailing `/`, so a card can say which of the three
 * names is a folder without a second field travelling beside them to disagree
 * with the first.
 *
 * The order is folders first, then names ascending, and it is deterministic on
 * purpose: this list feeds the card image's cache key, so a re-render that
 * produced the same names in a different order would name a different object
 * and re-publish an identical picture to every unfurler that had cached it.
 */
export function previewChildrenFrom(
  entries: ReadonlyArray<{
    kind: "file" | "folder";
    name: string;
    visibility?: Visibility;
  }>,
): string[] {
  // A folder reaches a `team` listing two ways: its own rule says `team`, or
  // `folderVisibleAtScope` let it through because something NESTED under it is
  // team. The second is deliberate — an owner who shares `2-areas/shared` out
  // of a private `2-areas` needs the ancestor to appear, or the thing they just
  // shared is reachable only by somebody who already knows its name — and the
  // disclosure it accepts is "an ancestor's name, in exchange for the shared
  // folder being reachable", to a signed-in MEMBER navigating a tree.
  //
  // A card is read by an anonymous crawler at an address anybody can type, and
  // cannot be retracted once unfurled. So a preview names a subfolder only when
  // it is team-visible in its own right. The entry already carries
  // `visibility: visibilityOf(child, rules)` — this reads the engine's answer
  // to that question rather than adding a predicate of its own, which is the
  // rule the two search dialects follow for the same reason.
  const visible = entries.filter(
    (entry) => entry.kind !== "folder" || entry.visibility !== "private",
  );
  const ordered = [...visible].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return boundPreviewChildren(
    ordered.map((entry) => (entry.kind === "folder" ? `${entry.name}/` : entry.name)),
  );
}
