/**
 * The landing page's words, in one place so they can be held to the rules.
 *
 * They were JSX text, which is fine until you notice that the vocabulary
 * decisions are **binding on copy** and nothing was checking: `brain` is
 * retired and appears in no new user-facing copy, and "context" is the
 * aggregate and the product name, never a single unit
 * (`docs/decisions/vocabulary-and-workspaces.md`). A rule enforced by
 * everybody remembering it is a rule with one bad afternoon left in it.
 *
 * Named constants because a test can address them and an editor can find
 * them. The hero's two lines stay two constants rather than one string with a
 * newline: RN-Web lays a nested `<Text>` out as an inline box that does not
 * inherit the parent's explicit `lineHeight`, so the second line collapsed
 * onto the first — see `Landing.tsx`.
 *
 * Their **width** is governed separately and by measurement, not by counting
 * characters: `hero.ts` holds the bound and records what happened the last
 * time somebody reasoned about it from character counts instead.
 */

/** The lit first line. */
export const HERO_LINE_ONE = "Notes for your team";

/** The dimmed second line. */
export const HERO_LINE_TWO = "and your agents.";

/** The paragraph under the hero. */
export const HERO_SUB =
  "A simple notes app your team works in — and so do your agents. Everything " +
  "stays plain Markdown in storage you own, so the same notes open here, in " +
  "Obsidian, or through Claude, Cursor and anything else that speaks MCP.";

/** Under the buttons: how storage gets connected. */
export const HERO_ALSO = "Dropbox in one click · or bring your own bucket";

/** Every string on this page that a visitor reads, for the copy rules to check. */
export const LANDING_COPY = [
  HERO_LINE_ONE,
  HERO_LINE_TWO,
  HERO_SUB,
  HERO_ALSO,
] as const;
