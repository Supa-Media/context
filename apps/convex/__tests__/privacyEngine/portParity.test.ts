import { describe, expect, test } from "vitest";
import { type PrivacyRule } from "../gatewayFormat.helpers";
import {
  type Visibility,
  PrivacyOverrides,
  canSee,
  clearedOverrides,
  effectiveVisibility,
  isPlumbing,
  movedOverrides,
  nextOverrides,
  overrideFor,
  parsePrivacyManifest,
  renderPrivacyRulesBlock,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "../../functions/lib/privacy";
import {
  gateway,
  manifest,
  block,
  MANIFESTS,
  KEYS,
  SCOPES,
  outcome,
  normalise,
} from "./fixtures";

describe("the port parses exactly what the gateway parses", () => {
  test("the extraction is real — the gateway's parser is strict about its own format", () => {
    // `gatewayInternals()` already refuses to return a parser that accepts a
    // manifest with no markers. Pin one positive too, so "identical" below
    // cannot be satisfied by two functions that both do nothing.
    const parsed = gateway.parsePrivacyManifest(MANIFESTS["a shared projects folder with a private exception"]);
    expect(parsed.rules.length).toBe(3);
    expect(parsed.overrides.get("1-projects/pay.md")).toBe("private");
  });

  for (const [name, text] of Object.entries(MANIFESTS)) {
    test(`${name}`, () => {
      const mine = outcome(() => parsePrivacyManifest(text));
      const theirs = outcome(() => gateway.parsePrivacyManifest(text));

      expect(
        mine.ok,
        mine.ok
          ? "the port accepted a manifest the gateway rejects — the console would enforce rules the gateway does not"
          : "the port rejected a manifest the gateway accepts — the console would show an empty context",
      ).toBe(theirs.ok);

      if (mine.ok && theirs.ok) {
        expect(normalise(mine.value)).toEqual(normalise(theirs.value));
      }
    });
  }
});

describe("the port evaluates exactly what the gateway evaluates", () => {
  const parseable = Object.entries(MANIFESTS).filter(
    ([, text]) => outcome(() => gateway.parsePrivacyManifest(text)).ok,
  );

  test("there is something to compare", () => {
    expect(parseable.length).toBeGreaterThan(3);
  });

  for (const [name, text] of parseable) {
    test(`${name}`, () => {
      const parsed = gateway.parsePrivacyManifest(text);
      const rules = parsed.rules;
      const overrides = parsed.overrides as Map<string, Visibility>;

      for (const key of KEYS) {
        expect(visibilityOf(key, rules), `visibilityOf(${key})`).toBe(
          gateway.visibilityOf(key, rules),
        );
        expect(effectiveVisibility(key, rules, overrides), `effectiveVisibility(${key})`).toBe(
          gateway.effectiveVisibility(key, rules, overrides),
        );
        expect(isPlumbing(key), `isPlumbing(${key})`).toBe(gateway.isPlumbing(key));
        for (const scope of SCOPES) {
          expect(canSee(key, scope, rules, overrides), `canSee(${key}, ${scope})`).toBe(
            gateway.canSee(key, scope, rules, overrides),
          );
        }
      }
    });
  }
});

describe("the port renders exactly what the gateway renders", () => {
  const cases: Array<[string, PrivacyRule[], Array<[string, Visibility]>]> = [
    ["nothing at all", [], []],
    [
      "folders only",
      [
        { prefix: "2-areas", vis: "private" },
        { prefix: "1-projects", vis: "team" },
      ],
      [],
    ],
    [
      "overrides only",
      [],
      [
        ["2-areas/b.md", "team"],
        ["1-projects/a.md", "private"],
      ],
    ],
    [
      "both, out of order",
      [
        { prefix: "z-last", vis: "team" },
        { prefix: "a-first", vis: "private" },
      ],
      [
        ["z-last/z.md", "private"],
        ["a-first/a.md", "team"],
      ],
    ],
  ];

  for (const [name, rules, overrides] of cases) {
    test(name, () => {
      const map = new Map<string, Visibility>(overrides);
      expect(renderPrivacyRulesBlock(rules, map)).toBe(
        gateway.renderPrivacyRulesBlock(rules, map as Map<string, string>),
      );
    });

    test(`${name} — and the rewrite keeps the customer's prose`, () => {
      const map = new Map<string, Visibility>(overrides);
      const original = MANIFESTS["a fresh PARA scaffold"];
      const mine = replacePrivacyRulesBlock(original, rules, map);
      expect(mine).toBe(
        gateway.replacePrivacyRulesBlock(original, rules, map as Map<string, string>),
      );
      expect(mine).toContain("Some prose the customer wrote and we must not eat.");
      expect(mine).toContain("More prose, below the block.");
    });
  }

  test("what the port renders, the gateway parses back", () => {
    const rules: PrivacyRule[] = [
      { prefix: "1-projects", vis: "team" },
      { prefix: "2-areas", vis: "private" },
    ];
    const overrides = new Map<string, Visibility>([["1-projects/pay.md", "private"]]);
    const text = replacePrivacyRulesBlock(
      MANIFESTS["a fresh PARA scaffold"],
      rules,
      overrides,
    );
    const reparsed = gateway.parsePrivacyManifest(text);
    expect(normalise(reparsed)).toEqual(
      normalise({ rules, overrides: overrides as Map<string, string> }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                     the rules that are the console's, not the gateway's    */
/* -------------------------------------------------------------------------- */

describe("an exception that matches its folder default is removed, not written", () => {
  const rules: PrivacyRule[] = [
    { prefix: "1-projects", vis: "team" },
    { prefix: "2-areas", vis: "private" },
  ];

  test("setting a note to its folder's default drops the exception", () => {
    const overrides = new Map<string, Visibility>([["1-projects/a.md", "private"]]);
    const next = nextOverrides("1-projects/a.md", "team", rules, overrides);
    expect(next.has("1-projects/a.md")).toBe(false);
  });

  test("a redundant exception is never added in the first place", () => {
    const next = nextOverrides("2-areas/b.md", "private", rules, new Map());
    expect(next.size).toBe(0);
  });

  test("a genuine exception is written", () => {
    const next = nextOverrides("2-areas/b.md", "team", rules, new Map());
    expect(next.get("2-areas/b.md")).toBe("team");
  });

  /**
   * The point of the rule, stated as a property rather than a case: after any
   * `nextOverrides`, an entry exists **iff** it differs from the folder
   * default. That invariant is what the tree's "mark only the exceptions" UI
   * reads, so if it ever stops holding the console starts lying.
   */
  test("every surviving entry differs from its folder default", () => {
    let overrides = new Map<string, Visibility>();
    const paths = ["1-projects/a.md", "1-projects/b.md", "2-areas/c.md", "other/d.md"];
    for (const path of paths) {
      for (const visibility of ["private", "team"] as const) {
        overrides = nextOverrides(path, visibility, rules, overrides);
        for (const [key, value] of overrides) {
          expect(value, `${key} is a redundant exception`).not.toBe(
            visibilityOf(key, rules),
          );
        }
      }
    }
  });
});

describe("an exception travels with its note", () => {
  const rules: PrivacyRule[] = [
    { prefix: "1-projects", vis: "team" },
    { prefix: "2-areas", vis: "private" },
  ];

  test("moving a private note into a team folder keeps it private", () => {
    const overrides = new Map<string, Visibility>([["2-areas/pay.md", "private"]]);
    // It is private by inheritance in 2-areas, so it has no exception there…
    const start = nextOverrides("2-areas/pay.md", "private", rules, overrides);
    expect(start.size).toBe(0);
    // …but a note that *was* an exception keeps its effective visibility.
    const explicit = new Map<string, Visibility>([["1-projects/pay.md", "private"]]);
    const moved = movedOverrides("1-projects/pay.md", "1-projects/archive/pay.md", rules, explicit);
    expect(moved.get("1-projects/archive/pay.md")).toBe("private");
    expect(moved.has("1-projects/pay.md")).toBe(false);
  });

  test("moving into a folder that already defaults that way drops the exception", () => {
    const overrides = new Map<string, Visibility>([["1-projects/pay.md", "private"]]);
    const moved = movedOverrides("1-projects/pay.md", "2-areas/pay.md", rules, overrides);
    expect(moved.size).toBe(0);
  });

  test("a note with no exception moves without gaining one", () => {
    const moved = movedOverrides("1-projects/a.md", "2-areas/a.md", rules, new Map());
    expect(moved.size).toBe(0);
  });

  test("deleting a note forgets its exception", () => {
    const overrides = new Map<string, Visibility>([["1-projects/pay.md", "private"]]);
    expect(clearedOverrides("1-projects/pay.md", overrides).size).toBe(0);
  });
});

describe("frontmatter is description, the manifest is access control", () => {
  /**
   * The rule the product depends on: a note cannot widen its own audience by
   * saying so in its own body. Nothing in the engine reads the note at all —
   * `visibilityOf` and `effectiveVisibility` take a *key*, never content — and
   * this test states that as behaviour rather than as an architecture diagram.
   */
  test("a note claiming `visibility: team` in its frontmatter is still private", () => {
    const rules: PrivacyRule[] = [{ prefix: "2-areas", vis: "private" }];
    const overrides = new Map<string, Visibility>();
    const key = "2-areas/health.md";

    expect(effectiveVisibility(key, rules, overrides)).toBe("private");
    expect(canSee(key, "team", rules, overrides)).toBe(false);
    // And the gateway agrees, which is the only opinion that matters.
    expect(gateway.canSee(key, "team", rules, overrides as Map<string, string>)).toBe(false);
  });
});

/**
 * ONE OBJECT, ONE ANSWER — WHERE TWO STRINGS NAME ONE OBJECT.
 *
 * Every decision in both engines is keyed on an exact path. That is sound on a
 * keyspace where one string is one object, which R2 and S3 are and Dropbox is
 * not: `DropboxStore`'s own header records that Dropbox "treats `Foo.md` and
 * `foo.md` as the same file and normalises Unicode", and that it deliberately
 * does not re-case a caller's key, because a store that silently rewrote one
 * would be worse than one that returns what Dropbox actually has.
 *
 * That is right for the adapter and it left the question here. Note paths reach
 * both engines from outside — a connected AI client's tool call, a console
 * request — so on a Dropbox-backed context the caller picks which of two
 * strings to send, and therefore which of two answers to be scored by:
 *
 *  - `Privacy.md` is not `privacy.md`, so nothing reserved it, and Dropbox
 *    wrote the access map anyway.
 *  - a note re-cased inside a `team` folder misses its narrowing override while
 *    the FOLDER rule still matches, because folder matching is a prefix compare
 *    the re-casing leaves untouched. It scores `team`, and Dropbox returns the
 *    private file.
 *
 * The direction is what makes the second one a hole. Re-casing a *folder* makes
 * every rule miss and the `private` default takes over — closed. Re-casing a
 * *note* drops only the narrowing, and that is open.
 *
 * Both engines therefore fold, on every backend, and the assertions below are
 * doubled because a fold in one copy alone is the divergence this whole file
 * exists to prevent — the console calling a note private while the gateway
 * hands it to an AI client.
 */
describe("a privacy decision does not change when a path is re-cased", () => {
  const rules: PrivacyRule[] = [{ prefix: "1-projects", vis: "team" }];

  test("the manifest is reserved under any casing, in both engines", () => {
    for (const key of ["Privacy.md", "PRIVACY.MD", "privacy.md"]) {
      expect(isPlumbing(key), key).toBe(true);
      expect(gateway.isPlumbing(key), `gateway ${key}`).toBe(true);
      expect(canSee(key, "team", rules, new Map()), key).toBe(false);
      expect(gateway.canSee(key, "team", rules, new Map()), `gateway ${key}`).toBe(false);
    }
  });

  test("the legacy manifest is reserved under any casing, in both engines", () => {
    // `scopes.yml` is not dot-prefixed, so it rested on exact equality too.
    for (const key of ["Scopes.yml", "SCOPES.YML"]) {
      expect(isPlumbing(key), key).toBe(true);
      expect(gateway.isPlumbing(key), `gateway ${key}`).toBe(true);
    }
  });

  test("a narrowing override survives re-casing the note, in both engines", () => {
    const overrides = new Map<string, Visibility>([["1-projects/salary.md", "private"]]);
    // The positive control: without it, a note that was never team-visible
    // would satisfy the assertion below for the wrong reason.
    expect(canSee("1-projects/public.md", "team", rules, overrides)).toBe(true);
    expect(gateway.canSee("1-projects/public.md", "team", rules, overrides as Map<string, string>))
      .toBe(true);

    for (const key of ["1-projects/Salary.md", "1-projects/SALARY.MD", "1-projects/salary.md"]) {
      expect(effectiveVisibility(key, rules, overrides), key).toBe("private");
      expect(gateway.effectiveVisibility(key, rules, overrides), `gateway ${key}`).toBe("private");
      expect(canSee(key, "team", rules, overrides), key).toBe(false);
      expect(gateway.canSee(key, "team", rules, overrides as Map<string, string>), `gateway ${key}`)
        .toBe(false);
    }
  });

  /**
   * THE DIRECTION THAT MUST NOT FOLD, AND THE TEST THAT DID NOT TEST IT.
   *
   * The first version of this check used `2-areas/Published-Other.md`, which is
   * not a re-casing of `2-areas/published.md` at all — it folds to a different
   * string, so the assertion held whether the engine folded or not. It was
   * named for the one direction that matters and tested nothing, and the code
   * it was passing over really did widen: `overrideFor` folded every override,
   * `team` ones included, so a note the owner published by name lent its
   * visibility to every case-variant of itself. On a case-sensitive store —
   * R2, S3, every context deployed today — those are different files.
   *
   * So a fold may only ever NARROW. This is the same argument that keeps folder
   * rules unfolded, applied to note overrides, and the fix was to apply it
   * rather than to restate it.
   */
  test("a widening override does not travel by re-casing, in both engines", () => {
    const privateRules: PrivacyRule[] = [{ prefix: "2-areas", vis: "private" }];
    const overrides = new Map<string, Visibility>([["2-areas/published.md", "team"]]);

    // The positive control: the note the owner actually named is readable.
    expect(canSee("2-areas/published.md", "team", privateRules, overrides)).toBe(true);
    expect(
      gateway.canSee("2-areas/published.md", "team", privateRules, overrides as Map<string, string>),
    ).toBe(true);

    // Its case-variants are not, in either engine.
    for (const key of ["2-areas/Published.md", "2-areas/PUBLISHED.MD"]) {
      expect(effectiveVisibility(key, privateRules, overrides), key).toBe("private");
      expect(gateway.effectiveVisibility(key, privateRules, overrides), `gateway ${key}`).toBe(
        "private",
      );
      expect(canSee(key, "team", privateRules, overrides), key).toBe(false);
      expect(
        gateway.canSee(key, "team", privateRules, overrides as Map<string, string>),
        `gateway ${key}`,
      ).toBe(false);
    }
  });

  test("two overrides that fold together resolve to private, whatever their order", () => {
    // One file on Dropbox, two manifest lines, a contradiction the owner never
    // resolved. Resolving it by which line came first is arbitrary, and one of
    // the two orders fails open.
    const teamRules: PrivacyRule[] = [{ prefix: "a", vis: "team" }];
    const orders: [string, Visibility][][] = [
      [["a/Foo.md", "team"], ["a/foo.md", "private"]],
      [["a/foo.md", "private"], ["a/Foo.md", "team"]],
    ];
    for (const entries of orders) {
      const overrides = new Map<string, Visibility>(entries);
      const label = entries.map(([k]) => k).join(" then ");
      expect(effectiveVisibility("a/FOO.MD", teamRules, overrides), label).toBe("private");
      expect(gateway.effectiveVisibility("a/FOO.MD", teamRules, overrides), `gateway ${label}`).toBe(
        "private",
      );
    }
  });

  /**
   * A FOLD READS ACROSS CASE; IT MUST NEVER WRITE ACROSS IT.
   *
   * An earlier version of this change also folded the *deletion* of an
   * override, so that setting a visibility dropped every entry folding onto the
   * path. On a case-sensitive store that silently rewrote a different note:
   * publishing `1-projects/Notes.md` stripped `1-projects/notes.md`'s narrowing
   * — consent obtained for one file and spent on another — and creating
   * `2-areas/Report.md` un-shared `2-areas/report.md` with no message anywhere.
   * Nothing in either suite noticed, which is why these are here.
   */
  test("changing one note's visibility leaves a case-twin's override alone", () => {
    const teamRules: PrivacyRule[] = [{ prefix: "1-projects", vis: "team" }];
    const overrides = new Map<string, Visibility>([["1-projects/notes.md", "private"]]);

    const published = nextOverrides("1-projects/Notes.md", "team", teamRules, overrides);
    expect(published.get("1-projects/notes.md")).toBe("private");
    expect(canSee("1-projects/notes.md", "team", teamRules, published)).toBe(false);

    const cleared = clearedOverrides("1-projects/NOTES.MD", overrides);
    expect(cleared.get("1-projects/notes.md")).toBe("private");

    const moved = movedOverrides("1-projects/Notes.md", "1-projects/moved.md", teamRules, overrides);
    expect(moved.get("1-projects/notes.md")).toBe("private");
  });

  test("re-casing a FOLDER stays closed rather than folding, in both engines", () => {
    // Folder rules are deliberately not folded: the default is `private`, so a
    // missed prefix already fails closed, and folding them would let a `team`
    // rule match folders its author never named.
    const key = "1-Projects/anything.md";
    expect(visibilityOf(key, rules)).toBe("private");
    expect(gateway.visibilityOf(key, rules)).toBe("private");
    expect(canSee(key, "team", rules, new Map())).toBe(false);
    expect(gateway.canSee(key, "team", rules, new Map())).toBe(false);
  });

  /**
   * THE INDEX ACCELERATES AND MUST NEVER DECIDE.
   *
   * `PrivacyOverrides` precomputes the folded set so `canSee` is not a scan on
   * the search path. The first version of this PR made the *container* decide
   * the answer — a `Map` subclass that folded, beside plain maps that did not —
   * which is how the two engines came to disagree about a live note. So the
   * property is not "the index is fast", it is "the index and the scan cannot
   * differ", and a plain `Map` is the scan.
   */
  test("the folded index and the plain-map scan give the same answer", () => {
    const entries: [string, Visibility][] = [
      ["1-projects/salary.md", "private"],
      ["1-projects/published.md", "team"],
      ["1-projects/reévaluation.md", "private"],
    ];
    const indexed = new PrivacyOverrides();
    for (const [k, v] of entries) indexed.set(k, v);
    const plain = new Map<string, Visibility>(entries);

    for (const key of [
      "1-projects/salary.md",
      "1-projects/Salary.md",
      "1-projects/SALARY.MD",
      "1-projects/published.md",
      "1-projects/Published.md",
      "1-projects/reévaluation.md",
      "1-projects/absent.md",
    ]) {
      expect(overrideFor(indexed, key), `indexed ${key}`).toBe(overrideFor(plain, key));
      expect(effectiveVisibility(key, rules, indexed), `visibility ${key}`).toBe(
        effectiveVisibility(key, rules, plain),
      );
    }
  });

  /**
   * THE SAME RULE, DRIVEN THROUGH THE GATEWAY'S OWN CLASS.
   *
   * The check below imports `PrivacyOverrides` from `functions/lib/privacy`, so
   * it never touches the gateway's copy — and removing `this.folds = null` from
   * BOTH `set` and `delete` in `apps/mcp/src/index.js` passes all 989 gateway
   * checks and all of these. Two copies of one rule with only one checked, in
   * the repository whose own `no-ungated-native-import` section is about
   * exactly that.
   *
   * `gatewayInternals` exposes the real `parsePrivacyManifest`, which returns
   * the gateway's own `PrivacyOverrides`, so this drives the class rather than
   * a description of it.
   */
  test("the gateway's own index is dropped on a write too", () => {
    const parsed = gateway.parsePrivacyManifest(
      manifest(
        block([
          "default_visibility: private",
          "",
          "folder_defaults:",
          "  1-projects: team",
          "",
          "note_overrides:",
          "  1-projects/a.md: private",
        ]),
      ),
    );
    const overrides = parsed.overrides;
    // Read first, so an index exists to go stale.
    expect(gateway.effectiveVisibility("1-projects/A.md", parsed.rules, overrides)).toBe("private");

    overrides.set("1-projects/b.md", "private");
    expect(gateway.effectiveVisibility("1-projects/B.md", parsed.rules, overrides)).toBe("private");

    overrides.delete("1-projects/a.md");
    expect(gateway.effectiveVisibility("1-projects/A.md", parsed.rules, overrides)).toBe("team");
  });

  test("a write drops the folded index rather than serving a stale one", () => {
    const overrides = new PrivacyOverrides();
    overrides.set("1-projects/a.md", "private");
    // Read it, so an index exists to go stale.
    expect(overrideFor(overrides, "1-projects/A.md")).toBe("private");

    overrides.set("1-projects/b.md", "private");
    expect(overrideFor(overrides, "1-projects/B.md")).toBe("private");

    overrides.delete("1-projects/a.md");
    expect(overrideFor(overrides, "1-projects/A.md")).toBeUndefined();
    expect(canSee("1-projects/A.md", "team", rules, overrides)).toBe(true);
  });

  test("Unicode composition is folded too, in both engines", () => {
    // Dropbox normalises Unicode as well as case. NFD "é" is two code points
    // and NFC "é" is one; they are the same file there.
    const nfc = "1-projects/reévaluation.md";
    const nfd = "1-projects/reévaluation.md";
    expect(nfc).not.toBe(nfd);
    const overrides = new Map<string, Visibility>([[nfc, "private"]]);
    expect(effectiveVisibility(nfd, rules, overrides)).toBe("private");
    expect(gateway.effectiveVisibility(nfd, rules, overrides)).toBe("private");
  });
});

/* -------------------------------------------------------------------------- */
/*                        a rule may name a group                             */
/* -------------------------------------------------------------------------- */

/**
 * The differential tests above prove the two engines AGREE. They cannot prove
 * either is right — two copies of one mistake agree perfectly — so the rules a
 * group rule introduces are pinned here as behaviour, on both engines.
 *
 * The claim under all of it: **a group is narrower than `team` and wider than
 * `private`**, and clearance stays two-valued so that nothing already granted
 * silently widens.
 */
