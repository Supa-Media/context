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

/**
 * The navigation bar's two links, and its two actions.
 *
 * Two, not the canvas's four: it draws Docs / Architecture / Pricing / GitHub,
 * and of those only Architecture and GitHub have somewhere to go. A nav row
 * with a `Docs` link and no docs is a worse page than one with two links, and
 * "match the picture" does not extend to inventing destinations.
 *
 * `NAV_START` is the same action as the hero's primary button and deliberately
 * says something shorter: a nav button is read as "how do I begin", the hero's
 * as "begin with what".
 */
export const NAV_ARCHITECTURE = "Architecture";
export const NAV_GITHUB = "GitHub";
export const NAV_SIGN_IN = "Sign in";
export const NAV_START = "Get started";

/**
 * THE ENDPOINT SECTION — one URL, every client.
 *
 * The canvas draws a dark bar holding the MCP address with a Copy button, and
 * a line of client names under it. The address shown is a *shape*, not a live
 * one: a visitor has no workspace yet, so `@you` is the placeholder the form
 * takes rather than somebody's real handle.
 */
export const ENDPOINT_TITLE_ONE = "One endpoint.";
export const ENDPOINT_TITLE_TWO = "Every client.";
export const ENDPOINT_BODY =
  "Add one URL once. Every assistant you use reads the same notes and writes " +
  "back to them — each write recorded in your own audit trail, under the name " +
  "of the client that made it.";
export const ENDPOINT_SCHEME = "https://";
export const ENDPOINT_HOST = "mcp.context.lc/@you";
export const ENDPOINT_COPY = "Copy";
export const ENDPOINT_CLIENTS_LEAD = "Works with anything that speaks MCP —";
export const ENDPOINT_CLIENTS_TAIL = "and the next one";
export const CLIENT_CLAUDE = "Claude";
export const CLIENT_CURSOR = "Cursor";
export const CLIENT_VSCODE = "VS Code";
export const CLIENT_ZED = "Zed";

/**
 * THE THREE ASSURANCES, WHICH ARE THE NON-NEGOTIABLES IN A VISITOR'S WORDS.
 *
 * Each is `CLAUDE.md`'s own promise said once, plainly, and nothing beyond it.
 * That constraint is the point: a landing page is where a product's guarantees
 * get rounded up, and these three are the ones this repository will not round.
 * `landingCopy.test.ts`'s overclaim list is aimed at exactly this block.
 */
export const ASSURE_BUCKET_TITLE = "It is your bucket";
export const ASSURE_BUCKET_BODY =
  "Canonical Markdown and attachments live in storage dedicated to your " +
  "workspace. We hold accounts, grants and audit — never a line of your note " +
  "content. Revoke our credential and you still have a complete, working " +
  "set of notes.";
export const ASSURE_FILES_TITLE = "Plain files stay canonical";
export const ASSURE_FILES_BODY =
  "A note lives at a real path in a real folder. Not in a database, not " +
  "behind an export button. Search indexes and embeddings are disposable " +
  "derivatives, rebuildable from the files — never the only copy of anything.";
export const ASSURE_EXIT_TITLE = "Leaving is free, on both plans";
export const ASSURE_EXIT_BODY =
  "Download everything, or hand the bucket to storage of your own. Identical " +
  "whether you pay us or not, never behind a paywall, and it still works " +
  "after you cancel. Cancelling makes a workspace read-only. It never deletes.";

/** The footer's line about the licence, beside the mark. */
export const FOOT_LICENCE = "MIT licensed open source on GitHub";

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
  ENDPOINT_TITLE_ONE,
  ENDPOINT_TITLE_TWO,
  ENDPOINT_BODY,
  ENDPOINT_SCHEME,
  ENDPOINT_HOST,
  ENDPOINT_COPY,
  ENDPOINT_CLIENTS_LEAD,
  ENDPOINT_CLIENTS_TAIL,
  CLIENT_CLAUDE,
  CLIENT_CURSOR,
  CLIENT_VSCODE,
  CLIENT_ZED,
  ASSURE_BUCKET_TITLE,
  ASSURE_BUCKET_BODY,
  ASSURE_FILES_TITLE,
  ASSURE_FILES_BODY,
  ASSURE_EXIT_TITLE,
  ASSURE_EXIT_BODY,
  FOOT_LICENCE,
  NAV_ARCHITECTURE,
  NAV_GITHUB,
  NAV_SIGN_IN,
  NAV_START,
  PRIVACY_LINK,
  TERMS_LINK,
  DEMO_FOOT,
  LICENCE_FOOT,
  // The continuity demo, which is the first section a visitor reads and was
  // the last one any rule here could see.
  ...DEMO_COPY,
];
