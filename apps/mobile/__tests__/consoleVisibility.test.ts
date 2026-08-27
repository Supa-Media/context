import { describe, expect, jest, test } from "@jest/globals";
import type { WorkspaceRole } from "@context/convex/functions/lib/workspaceAuth";
import { scopeForRole } from "@context/convex/functions/files";
import {
  isFilteredView,
  memberReachSentence,
  tierChipLabel,
  tierSentence,
  visibilityTierForRole,
} from "../features/console/visibility";

/**
 * The class of bug this file exists to prevent: **the console telling somebody
 * they can see more of a context than the backend will ever hand them, or less
 * of their own than they actually have.**
 *
 * `features/console/visibility.ts` writes nothing down. It re-derives the tier
 * from `role` on every render, precisely so there is no second stored copy to
 * drift from the enforcing one — CLAUDE.md is explicit that a tier stored twice
 * is a tier that can disagree with itself, and that the direction it fails is
 * "an AI client reads more than the person allowed". But "derived" is not the
 * same as "derived correctly", and a derivation nobody checks is the guard this
 * repository has been caught shipping three times.
 *
 * So the first block below does not describe the rule in prose and trust the
 * mobile copy of it. It imports `scopeForRole` — the function in
 * `apps/convex/functions/files.ts` that actually decides what the console
 * hands over — and asserts this module agrees with it for every role that
 * exists. Sabotage check: change `visibilityTierForRole` to answer `"private"`
 * for `editor` and the very first test fails.
 *
 * The remaining blocks pin the two edges a copy change is most likely to
 * quietly break: an owner is never told they are limited, and a role we do not
 * yet know is described in no words at all.
 */

/*
  `@convex-dev/auth` publishes `./server` under an `import` condition only, so
  Jest's CommonJS resolver cannot see it and `files.ts` cannot be loaded without
  this stand-in. It is a resolution shim, not a behavioural mock: nothing under
  test here calls `getAuthUserId`, and `scopeForRole` is a pure function of its
  argument sitting in the same module.
*/
jest.mock("@convex-dev/auth/server", () => ({ getAuthUserId: () => null }), { virtual: true });

/** Every role the control plane can store. Exhaustive by its own type. */
const EVERY_ROLE: WorkspaceRole[] = ["owner", "editor", "member"];

describe("what the console says it can see agrees with what the backend will hand over", () => {
  test("every role resolves to the same tier the control plane's own scopeForRole picks", () => {
    for (const role of EVERY_ROLE) {
      // Not "the same idea as" — the same value, from the function that
      // enforces it. This is the assertion that makes the chip more than
      // decoration.
      expect(visibilityTierForRole(role)).toBe(scopeForRole(role));
    }
  });

  test("the owner is the only role that reads at private", () => {
    // Stated separately from the loop above so that a `scopeForRole` which
    // started returning "private" for everybody would fail here even while the
    // loop kept passing against it.
    expect(visibilityTierForRole("owner")).toBe("private");
    expect(visibilityTierForRole("editor")).toBe("team");
    expect(visibilityTierForRole("member")).toBe("team");
  });

  test("an editor is filtered even though an editor can write", () => {
    // The conflation the module comment in `functions/files.ts` was written to
    // prevent: being trusted to change notes is not being trusted to read the
    // ones somebody marked private.
    expect(isFilteredView("editor")).toBe(true);
    expect(isFilteredView("member")).toBe(true);
    expect(isFilteredView("owner")).toBe(false);
  });
});

describe("an owner is not told they are limited", () => {
  test("no chip", () => {
    // `null`, not an empty string: `TierChip` renders nothing at all rather
    // than an empty pill outline sitting in the pane head.
    expect(tierChipLabel("owner")).toBeNull();
  });

  test("no sentence", () => {
    // A line reassuring an owner that they can read their own notes is noise,
    // and noise beside a warning is how the warning gets skimmed past.
    expect(tierSentence("owner")).toBeNull();
  });

  test("and the one line they do get is about the people they invited, not about themselves", () => {
    const reach = memberReachSentence("owner");
    expect(reach).not.toBeNull();
    expect(reach).toContain("team level");
    // It says the rule. It must never grow a count: `ConsoleData` carries no
    // note census, so any number here would be invented. See the function's
    // comment.
    expect(reach).not.toMatch(/\d/);
  });

  test("nobody else gets the owner's line", () => {
    // It describes a decision only the owner made. On somebody else's context
    // "anything you marked private is yours alone" is a claim about the wrong
    // person's notes.
    expect(memberReachSentence("editor")).toBeNull();
    expect(memberReachSentence("member")).toBeNull();
    expect(memberReachSentence(undefined)).toBeNull();
  });
});

describe("a role the console does not know yet is described in no words at all", () => {
  /*
    `undefined` is the ordinary state for the half second before the first
    Convex round-trip lands, and `null` is what an absent selected context
    yields. Both are "we do not know which context this is", and an incorrect
    reassurance is worse than a beat of silence.
  */
  test("undefined says nothing", () => {
    expect(visibilityTierForRole(undefined)).toBe("unknown");
    expect(tierChipLabel(undefined)).toBeNull();
    expect(tierSentence(undefined)).toBeNull();
    expect(isFilteredView(undefined)).toBe(false);
  });

  test("null says nothing", () => {
    expect(visibilityTierForRole(null)).toBe("unknown");
    expect(tierChipLabel(null)).toBeNull();
    expect(tierSentence(null)).toBeNull();
  });

  test("a role string this build has never heard of says nothing either", () => {
    // The tempting shortcut is "not owner, therefore team", which is what the
    // backend does and which would never over-promise access. It is still
    // wrong: a chip is a claim about a named context, and a role we cannot
    // read means we do not know whose context we are drawing.
    for (const unknown of ["", "viewer", "admin", "OWNER", "owner "]) {
      expect(visibilityTierForRole(unknown)).toBe("unknown");
      expect(tierChipLabel(unknown)).toBeNull();
      expect(tierSentence(unknown)).toBeNull();
      expect(memberReachSentence(unknown)).toBeNull();
    }
  });
});

describe("the words themselves", () => {
  test("the chip is a label in the console's register, not a sentence", () => {
    // Lower case and no full stop, like `no bucket connected` and `4 active`.
    expect(tierChipLabel("member")).toBe("team level only");
    expect(tierChipLabel("editor")).toBe("team level only");
  });

  test("a member and an editor are told different things, because the surprise is different", () => {
    const forMember = tierSentence("member");
    const forEditor = tierSentence("editor");
    expect(forMember).not.toBe(forEditor);
    // The editor's line has to address the thing an editor will otherwise
    // assume: that write access came with read access to everything.
    expect(forEditor).toContain("edit");
  });

  test("neither line offers a setting that does not exist", () => {
    // The consent screen's failure mode in reverse: this is not a preference
    // somebody can turn up. `scopeForRole` clamps before any scope is read.
    for (const role of ["member", "editor"]) {
      const sentence = tierSentence(role);
      expect(sentence).not.toBeNull();
      expect(sentence!.toLowerCase()).not.toContain("public");
      expect(sentence!).toContain("private");
    }
  });
});
