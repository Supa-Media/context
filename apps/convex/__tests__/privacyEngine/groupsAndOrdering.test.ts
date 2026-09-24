import { describe, expect, test } from "vitest";
import {
  PrivacyOverrides,
  canSee,
  effectiveVisibility,
  narrowerVisibility,
  overrideFor,
  parsePrivacyManifest,
  type Visibility,
} from "../../functions/lib/privacy";
import {
  gateway,
  manifest,
  block,
} from "./fixtures";

describe("a group is narrower than team, in both engines", () => {
  const text = manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  2-areas/feedback: @supa-owners",
      "",
      "note_overrides:",
      "  1-projects/rates.md: @supa-leads",
    ]),
  );
  const mine = parsePrivacyManifest(text);
  const theirs = gateway.parsePrivacyManifest(text);
  const GROUPED = "2-areas/feedback/q3.md";
  const TEAM = "1-projects/roadmap.md";
  const HELD_BACK = "1-projects/rates.md";

  test("the group survives parsing as the rule's value, not as a tier", () => {
    expect(effectiveVisibility(GROUPED, mine.rules, mine.overrides)).toBe("@supa-owners");
    expect(gateway.effectiveVisibility(GROUPED, theirs.rules, theirs.overrides)).toBe(
      "@supa-owners",
    );
    expect(effectiveVisibility(HELD_BACK, mine.rules, mine.overrides)).toBe("@supa-leads");
    expect(gateway.effectiveVisibility(HELD_BACK, theirs.rules, theirs.overrides)).toBe(
      "@supa-leads",
    );
  });

  test("a team connection cannot see a group-scoped note", () => {
    // Non-vacuity first: the same caller CAN see the team note beside it, so
    // the refusals below are the clamp rather than a manifest that parsed to
    // nothing.
    expect(canSee(TEAM, "team", mine.rules, mine.overrides)).toBe(true);
    expect(gateway.canSee(TEAM, "team", theirs.rules, theirs.overrides)).toBe(true);

    expect(canSee(GROUPED, "team", mine.rules, mine.overrides)).toBe(false);
    expect(gateway.canSee(GROUPED, "team", theirs.rules, theirs.overrides)).toBe(false);
    expect(canSee(HELD_BACK, "team", mine.rules, mine.overrides)).toBe(false);
    expect(gateway.canSee(HELD_BACK, "team", theirs.rules, theirs.overrides)).toBe(false);
  });

  test("an owner's own connection still sees it", () => {
    expect(canSee(GROUPED, "private", mine.rules, mine.overrides)).toBe(true);
    expect(gateway.canSee(GROUPED, "private", theirs.rules, theirs.overrides)).toBe(true);
  });

  test("a team connection the owner added the group to sees exactly that group", () => {
    const granted = new Set(["@supa-owners"]);
    expect(canSee(GROUPED, "team", mine.rules, mine.overrides, granted)).toBe(true);
    expect(gateway.canSee(GROUPED, "team", theirs.rules, theirs.overrides, granted)).toBe(true);
    // …and not the other one. A grant carries named groups, never "any group".
    expect(canSee(HELD_BACK, "team", mine.rules, mine.overrides, granted)).toBe(false);
    expect(gateway.canSee(HELD_BACK, "team", theirs.rules, theirs.overrides, granted)).toBe(false);
  });

  test("an empty grant is the default, and it reaches no group at all", () => {
    const none = new Set<string>();
    expect(canSee(GROUPED, "team", mine.rules, mine.overrides, none)).toBe(false);
    expect(gateway.canSee(GROUPED, "team", theirs.rules, theirs.overrides, none)).toBe(false);
  });

  test("a group never becomes a clearance: the note is not visible to `@supa-owners` as a scope", () => {
    // `Scope` is two-valued and this is what stops a third value sneaking in
    // through the back door — an unrecognised scope must not read as private.
    expect(canSee(GROUPED, "@supa-owners" as never, mine.rules, mine.overrides)).toBe(false);
    expect(gateway.canSee(GROUPED, "@supa-owners", theirs.rules, theirs.overrides)).toBe(false);
  });
});

describe("a group override narrows by fold, the way `private` always has", () => {
  /**
   * The case the fold exists for, with a group in place of `private`: a `team`
   * folder, one note held back, and a caller who sends the other casing.
   * Before groups this was `private` and travelled; a group that did not
   * travel would be a leak on Dropbox, where the two strings are one file.
   */
  const text = manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "",
      "note_overrides:",
      "  1-projects/Rates.md: @supa-leads",
    ]),
  );
  const mine = parsePrivacyManifest(text);
  const theirs = gateway.parsePrivacyManifest(text);

  test("the twin casing is not team", () => {
    expect(effectiveVisibility("1-projects/rates.md", mine.rules, mine.overrides)).toBe(
      "@supa-leads",
    );
    expect(
      gateway.effectiveVisibility("1-projects/rates.md", theirs.rules, theirs.overrides),
    ).toBe("@supa-leads");
    expect(canSee("1-projects/rates.md", "team", mine.rules, mine.overrides)).toBe(false);
    expect(gateway.canSee("1-projects/rates.md", "team", theirs.rules, theirs.overrides)).toBe(
      false,
    );
  });

  test("a team override still does not travel", () => {
    const widening = manifest(
      block([
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  1-projects: private",
        "",
        "note_overrides:",
        "  1-projects/Rates.md: team",
      ]),
    );
    const parsed = parsePrivacyManifest(widening);
    const gatewayParsed = gateway.parsePrivacyManifest(widening);
    expect(effectiveVisibility("1-projects/rates.md", parsed.rules, parsed.overrides)).toBe(
      "private",
    );
    expect(
      gateway.effectiveVisibility("1-projects/rates.md", gatewayParsed.rules, gatewayParsed.overrides),
    ).toBe("private");
  });

  test("two different groups that fold together resolve to private, whatever their order", () => {
    for (const pair of [
      ["  1-projects/Rates.md: @supa-leads", "  1-projects/rates.md: @supa-owners"],
      ["  1-projects/rates.md: @supa-owners", "  1-projects/Rates.md: @supa-leads"],
    ]) {
      const contradiction = manifest(
        block([
          "default_visibility: private",
          "",
          "folder_defaults:",
          "  1-projects: team",
          "",
          "note_overrides:",
          ...pair,
        ]),
      );
      const parsed = parsePrivacyManifest(contradiction);
      const gatewayParsed = gateway.parsePrivacyManifest(contradiction);
      for (const key of ["1-projects/rates.md", "1-projects/Rates.md"]) {
        expect(effectiveVisibility(key, parsed.rules, parsed.overrides), key).toBe("private");
        expect(
          gateway.effectiveVisibility(key, gatewayParsed.rules, gatewayParsed.overrides),
          key,
        ).toBe("private");
      }
    }
  });

  test("the folded index and the plain-map scan agree about a group", () => {
    // `PrivacyOverrides` accelerates; a plain `Map` does not. The container may
    // change the speed and may never change the answer — the defect the fold
    // shipped with the first time.
    const fast = new PrivacyOverrides();
    fast.set("1-projects/Rates.md", "@supa-leads");
    const plain = new Map([["1-projects/Rates.md", "@supa-leads" as Visibility]]);
    expect(overrideFor(fast, "1-projects/rates.md")).toBe("@supa-leads");
    expect(overrideFor(plain, "1-projects/rates.md")).toBe("@supa-leads");
    expect(gateway.overrideFor(fast as never, "1-projects/rates.md")).toBe("@supa-leads");
    expect(gateway.overrideFor(plain as never, "1-projects/rates.md")).toBe("@supa-leads");
  });
});

describe("the narrowing order is the one both engines move notes by", () => {
  const cases: Array<[Visibility | undefined, Visibility | undefined, Visibility | undefined]> = [
    ["private", "team", "private"],
    ["team", "private", "private"],
    ["team", "team", "team"],
    ["private", "private", "private"],
    ["@supa-leads", "team", "@supa-leads"],
    ["team", "@supa-leads", "@supa-leads"],
    ["@supa-leads", "private", "private"],
    ["private", "@supa-leads", "private"],
    ["@supa-leads", "@supa-leads", "@supa-leads"],
    ["@supa-leads", "@supa-owners", "private"],
    [undefined, "@supa-leads", "@supa-leads"],
    ["@supa-leads", undefined, "@supa-leads"],
    [undefined, undefined, undefined],
  ];
  for (const [a, b, expected] of cases) {
    test(`${String(a)} + ${String(b)} → ${String(expected)}`, () => {
      expect(narrowerVisibility(a, b)).toBe(expected);
      expect(gateway.narrowerVisibility(a, b)).toBe(expected);
    });
  }
});

/* -------------------------------------------------------------------------- */
/*                a malformed group name fails the manifest closed             */
/* -------------------------------------------------------------------------- */

/**
 * The differential loop above proves the two engines AGREE about the invalid
 * manifests in the corpus. It does not prove either one REJECTS them, and for
 * five rounds it did not: deleting `GROUP_SCOPE_PATTERN`'s check from both
 * engines left `privacyEngine.test.ts`, the whole 2,393-test control-plane
 * suite and the whole gateway suite green, while `@Supa-Owners`, `@supa_owners`,
 * `@a` and `@-supa` were carried as visibility values.
 *
 * That is the shape this file exists to catch, found in this file: agreement is
 * not correctness, and a corpus entry named "invalid" asserts nothing unless
 * something asserts the rejection. `toThrow` is that something.
 *
 * Rejecting matters because the throw is what fails the manifest CLOSED. A name
 * waved through is a rule nothing can resolve being treated as a tier — and
 * since `canSee` answers a group by asking whether the grant carries that exact
 * string, an unresolvable name is a note nobody can read through any client,
 * with no error anywhere saying why.
 */
describe("a group name the namespace could never mint is rejected by both engines", () => {
  const REJECTED: Array<[string, string]> = [
    ["no name at all", "@"],
    ["uppercase, which no username may carry", "@Supa-Owners"],
    ["an underscore, which is outside [a-z0-9-]", "@supa_owners"],
    ["one character, under the two-character floor", "@a"],
    ["opening with a hyphen", "@-supa"],
    ["a name longer than a slug-prefixed pair can be", `@${"a".repeat(80)}`],
  ];

  for (const [why, value] of REJECTED) {
    test(`${why}: ${value.slice(0, 24)}`, () => {
      const text = manifest(
        block([
          "default_visibility: private",
          "",
          "folder_defaults:",
          `  1-projects: ${value}`,
          "",
          "note_overrides:",
          "  # No exact-note overrides.",
        ]),
      );
      expect(() => parsePrivacyManifest(text)).toThrow();
      expect(() => gateway.parsePrivacyManifest(text)).toThrow();
    });
  }

  /**
   * Trailing whitespace is TOLERATED, not rejected, and that is deliberate:
   * the line is trimmed before the value is matched, so a stray space in a
   * hand-edited file normalizes away instead of bricking every note in the
   * bucket. Pinned here because it was written as a rejection first, and the
   * failure is what showed the parser was kinder than the test assumed.
   */
  test("a stray trailing space normalizes away rather than failing closed", () => {
    const text = manifest(
      block([
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  1-projects: @supa-owners   ",
        "",
        "note_overrides:",
        "  # No exact-note overrides.",
      ]),
    );
    expect(parsePrivacyManifest(text).rules).toEqual([
      { prefix: "1-projects", vis: "@supa-owners" },
    ]);
    expect(gateway.parsePrivacyManifest(text).rules).toEqual([
      { prefix: "1-projects", vis: "@supa-owners" },
    ]);
  });

  test("the valid one in the same shape parses, so the rejections are not vacuous", () => {
    const text = manifest(
      block([
        "default_visibility: private",
        "",
        "folder_defaults:",
        "  1-projects: @supa-owners",
        "",
        "note_overrides:",
        "  # No exact-note overrides.",
      ]),
    );
    expect(parsePrivacyManifest(text).rules).toEqual([
      { prefix: "1-projects", vis: "@supa-owners" },
    ]);
    expect(gateway.parsePrivacyManifest(text).rules).toEqual([
      { prefix: "1-projects", vis: "@supa-owners" },
    ]);
  });
});
