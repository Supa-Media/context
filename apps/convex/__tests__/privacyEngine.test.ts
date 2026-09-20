/**
 * THE PRIVACY ENGINE, DIFFERENTIALLY TESTED AGAINST THE GATEWAY'S.
 *
 * `functions/lib/privacy.ts` is a port. The gateway's engine lives in
 * `apps/mcp/src/index.js` as module-private declarations with no exported
 * binding, so it cannot be imported into a Convex action — see that file's
 * header for the full reasoning and for the instruction to delete the port the
 * day it becomes importable.
 *
 * A port that is merely "carefully written" is worth nothing here. What makes
 * two visibility engines dangerous is not that one has a bug — it is that they
 * disagree, so a note the console shows as private is a note the gateway hands
 * to an AI client, or vice versa, and nothing anywhere throws.
 *
 * So this file does not test the port against expectations. It extracts the
 * gateway's **actual** functions (see `gatewayFormat.helpers.ts`) and runs both
 * implementations over the same matrix of manifests, keys, scopes and
 * malformed input, asserting identical results — including identical
 * *rejections*, since "one throws and the other returns empty rules" is the
 * most dangerous divergence of all: empty rules means everything is private,
 * which looks safe and silently empties the console.
 */

import { describe, expect, test } from "vitest";
import { gatewayInternals, type PrivacyRule } from "./gatewayFormat.helpers";
import {
  PRIVACY_RULES_BEGIN,
  PRIVACY_RULES_END,
  type Visibility,
  PrivacyOverrides,
  canSee,
  clearedOverrides,
  effectiveVisibility,
  isPlumbing,
  movedOverrides,
  nextOverrides,
  narrowerVisibility,
  overrideFor,
  parsePrivacyManifest,
  renderPrivacyRulesBlock,
  replacePrivacyRulesBlock,
  visibilityOf,
} from "../functions/lib/privacy";

const gateway = gatewayInternals();

/** Wrap a rules block in the prose a real `privacy.md` carries around it. */
function manifest(block: string): string {
  return [
    "---",
    "role: privacy-manifest",
    "---",
    "",
    "# Access map",
    "",
    "Some prose the customer wrote and we must not eat.",
    "",
    block,
    "",
    "More prose, below the block.",
    "",
  ].join("\n");
}

function block(lines: string[]): string {
  return [PRIVACY_RULES_BEGIN, "", "```yaml", ...lines, "```", "", PRIVACY_RULES_END].join(
    "\n",
  );
}

/* -------------------------------------------------------------------------- */
/*                             the manifest corpus                            */
/* -------------------------------------------------------------------------- */

/**
 * Every manifest below is a shape a real bucket can be in. The invalid ones
 * are not padding: a manifest that one engine rejects and the other accepts is
 * the divergence that matters most, because the two then disagree about
 * *every* note in the bucket at once.
 */
const MANIFESTS: Record<string, string> = {
  "a fresh PARA scaffold": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  0-inbox: private",
      "  1-projects: private",
      "  2-areas: private",
      "  3-resources: private",
      "  4-archive: private",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a shared projects folder with a private exception": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  1-projects/secret: private",
      "  2-areas: private",
      "",
      "note_overrides:",
      "  1-projects/pay.md: private",
      "  2-areas/team-handbook.md: team",
    ]),
  ),

  "a group rule on a folder and on one note": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "  2-areas/feedback: @supa-owners",
      "",
      "note_overrides:",
      "  1-projects/pay.md: @supa-leads",
      "  2-areas/team-handbook.md: team",
    ]),
  ),

  "a group named for one person, which is the same token": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: team",
      "",
      "note_overrides:",
      "  1-projects/a.md: @kola",
    ]),
  ),

  // Invalid, and each for a different reason a name can be wrong. A manifest
  // either engine accepts here is a rule nothing can resolve being carried as
  // though it were a tier.
  "a group with no name": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group with an uppercase name": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @Supa-Owners",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group with an underscore in it": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @supa_owners",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group name one character long": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @a",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "a group name opening with a hyphen": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: @-supa",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "no folder rules at all": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  # No folder defaults. All content is private.",
      "",
      "note_overrides:",
      "  # No exact-note overrides.",
    ]),
  ),

  "trailing slashes and leading slashes": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  /1-projects/: team",
      "",
      "note_overrides:",
      "  /1-projects/a.md: private",
    ]),
  ),

  "the legacy `public` word is not accepted here": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: public",
      "",
      "note_overrides:",
    ]),
  ),

  "no managed block at all": "# Access map\n\nnothing to see here\n",

  "a block with no default_visibility": manifest(
    block(["folder_defaults:", "  1-projects: team", "", "note_overrides:"]),
  ),

  "a rule before any section header": manifest(
    block(["default_visibility: private", "  1-projects: team"]),
  ),

  "a reserved dot path as a folder rule": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  .history: team",
      "",
      "note_overrides:",
    ]),
  ),

  "a note override that is not markdown": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "",
      "note_overrides:",
      "  1-projects/notes.txt: team",
    ]),
  ),

  "a note override naming privacy.md itself": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "",
      "note_overrides:",
      "  privacy.md: team",
    ]),
  ),

  "an unparseable visibility word": manifest(
    block([
      "default_visibility: private",
      "",
      "folder_defaults:",
      "  1-projects: sometimes",
      "",
      "note_overrides:",
    ]),
  ),
};

const KEYS = [
  "index.md",
  "privacy.md",
  "scopes.yml",
  "0-inbox/thought.md",
  "1-projects/a.md",
  "1-projects/pay.md",
  "1-projects/secret/plan.md",
  "1-projects-other/a.md",
  "2-areas/team-handbook.md",
  "2-areas/health.md",
  "2-areas/feedback/q3.md",
  "4-archive/2026/old.md",
  ".history/1-projects/a.md.2026.md",
  ".obsidian/workspace.json",
  "deeply/nested/but/unruled.md",
];

const SCOPES = ["private", "team"] as const;

/** Run a function and record either its value or the fact that it threw. */
function outcome<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

/** Comparable form: Maps do not survive `toEqual` against a plain object. */
function normalise<V extends string>(parsed: {
  rules: PrivacyRule[];
  // Generic in the value so the port's own `PrivacyManifest` (values typed
  // `Visibility`) and the gateway's extracted shape (plain strings, since the
  // extraction cannot know the union) both fit. A group value is a string
  // either way, and this function only sorts and compares.
  overrides: ReadonlyMap<string, V>;
}) {
  return {
    rules: [...parsed.rules].sort((a, b) => a.prefix.localeCompare(b.prefix)),
    overrides: [...parsed.overrides.entries()].sort(([a], [b]) => a.localeCompare(b)),
  };
}

/* -------------------------------------------------------------------------- */

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
