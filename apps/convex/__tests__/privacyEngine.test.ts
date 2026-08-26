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
  canSee,
  clearedOverrides,
  effectiveVisibility,
  isPlumbing,
  movedOverrides,
  nextOverrides,
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
function normalise(parsed: {
  rules: PrivacyRule[];
  overrides: Map<string, string>;
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
