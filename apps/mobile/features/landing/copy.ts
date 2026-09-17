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
 * The continuity demo's words live in `demoCopy.ts` and are spread into the
 * list below. They are a section's prose plus a transcript rather than a line
 * each, and they were literals in the component until the scan that reads this
 * file was widened from `Landing.tsx` to the folder it sits in.
 *
 * Their **width** is governed separately and by measurement, not by counting
 * characters: `hero.ts` holds the bound and records what happened the last
 * time somebody reasoned about it from character counts instead.
 */

import { DEMO_COPY } from "./demoCopy";

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

/** The licence badge, which a screen reader reads as the badge's whole sentence. */
export const LICENCE_BADGE = "Context is MIT licensed open source on GitHub";

/** The second call to action, beside the primary one. */
export const ARCHITECTURE_CTA = "Read the architecture";

/** The proof section: what the product is not, then what it is. */
export const PROOF_EYEBROW = "No magic layer";
export const PROOF_TITLE = "Just Markdown. Yours to touch.";
export const PROOF_FOLDER = "your-workspace/";
export const PROOF_FOOT = "Edit here · open in Obsidian · sync or self-host";

/** The line that introduces the store links. */
export const ALSO_ON_PHONE = "Also on your phone:";

/** The store links beside the proof section. */
export const STORE_IOS = "iOS";
export const STORE_ANDROID = "Android";

/** The two legal links in the foot. */
export const PRIVACY_LINK = "Privacy";
export const TERMS_LINK = "Terms";

/**
 * The proof section's paragraph — the longest prose on the page.
 *
 * It lived as a three-line JSX text run, which is why the first version of the
 * completeness scan walked past it: a pattern that forbade a newline inside a
 * run could not see the biggest thing on the page it was checking.
 */
export const PROOF_BODY =
  "Context stores ordinary files and folders—the same building blocks you already " +
  "know from Obsidian. Let an AI organize them, or open the editor yourself to write, " +
  "rename, move, and shape it all by hand.";

/** The two feet under the demo. */
export const DEMO_FOOT = "Demo — sign in for your own workspace";
export const LICENCE_FOOT = "MIT · self-hostable";

/**
 * Every string on this page that a visitor reads, for the copy rules to check.
 *
 * **This list is the page, and `landingCopy.test.ts` holds it to that** by
 * reading `Landing.tsx` and refusing any sentence that is not here. It used to
 * be the hero's four lines while eight more were literals in the component —
 * so every rule in that suite was silent on two thirds of what a visitor reads,
 * including two claims: *"Just Markdown. Yours to touch."* and
 * *"MIT · self-hostable"*. **An incomplete list passes for the same reason
 * an empty one does**, which is the hazard the suite's first case was already
 * written for, one step short.
 */
export const LANDING_COPY = [
  HERO_LINE_ONE,
  HERO_LINE_TWO,
  HERO_SUB,
  HERO_ALSO,
  LICENCE_BADGE,
  ARCHITECTURE_CTA,
  PROOF_EYEBROW,
  PROOF_TITLE,
  PROOF_FOLDER,
  PROOF_BODY,
  PROOF_FOOT,
  ALSO_ON_PHONE,
  STORE_IOS,
  STORE_ANDROID,
  PRIVACY_LINK,
  TERMS_LINK,
  DEMO_FOOT,
  LICENCE_FOOT,
  // The continuity demo, which is the first section a visitor reads and was
  // the last one any rule here could see.
  ...DEMO_COPY,
];
