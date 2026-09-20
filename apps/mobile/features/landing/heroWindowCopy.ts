/**
 * The hero window's contents, in their own module for the reason `demoCopy.ts`
 * is in its own.
 *
 * `landingCopy.test.ts` reads `copy.ts` and asserts that **every exported
 * constant is a parsed string and every parsed string is in the list** — the
 * two halves meeting in the middle, so neither direction relies on somebody
 * remembering. An array export is a shape that reader cannot parse, and its own
 * comment says such a constant must *fail* there rather than be skipped. It
 * did, which is the guard working.
 *
 * So this goes where `DEMO_COPY` goes: a sibling module, spread into
 * `LANDING_COPY`. The strings are still governed — the folder scan reads every
 * component, and the vocabulary and overclaim rules read the list.
 */
export const HERO_WINDOW_COPY = [
  "@seyi",
  "0-inbox",
  "1-projects",
  "2-areas",
  "spirit",
  "bible-study",
  "kings",
  "2-kings-4",
  "2-kings-5",
  "luke",
  "memory-verses",
  "3-resources",
  "team",
  "3",
  "spirit / bible-study / kings · private",
  "Summary",
  "Naaman was a warrior in Aram, widely respected, but he had leprosy. An " +
    "Israelite woman who served his wife mentioned that there was a prophet in " +
    "Israel who could heal him.",
  "2-areas/spirit/bible-study/kings/2-kings-5.md",
  "saved",
  "S",
];

