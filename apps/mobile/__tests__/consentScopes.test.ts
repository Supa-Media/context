import { describe, expect, test } from "@jest/globals";
import {
  hasElevatedScope,
  normalizeScopes,
  scopeSentences,
} from "../features/consent/scopes";

/**
 * The consent screen's whole job is to let someone weigh what they are handing
 * over. These tests exist to make three properties non-negotiable:
 *
 *  1. Nothing a client asked for is dropped from the list.
 *  2. A wildcard is never described as anything narrower than everything.
 *  3. A scope we cannot describe is *said* to be one, rather than being
 *     silently omitted or folded into a reassuring summary.
 */

const ids = (scopes: string | string[]) => scopeSentences(scopes).map((line) => line.id);
const sentences = (scopes: string | string[]) =>
  scopeSentences(scopes).map((line) => line.sentence);

describe("normalizeScopes", () => {
  test("splits the OAuth space-delimited form", () => {
    expect(normalizeScopes("context:read context:write")).toEqual([
      "context:read",
      "context:write",
    ]);
  });

  test("takes an array unchanged", () => {
    expect(normalizeScopes(["context:read"])).toEqual(["context:read"]);
  });

  test("tolerates commas, runs of whitespace, and empties", () => {
    expect(normalizeScopes("  read,  write \n delete ")).toEqual(["read", "write", "delete"]);
    expect(normalizeScopes("")).toEqual([]);
    expect(normalizeScopes(null)).toEqual([]);
    expect(normalizeScopes(undefined)).toEqual([]);
  });

  test("drops a repeated scope", () => {
    expect(normalizeScopes("read read write")).toEqual(["read", "write"]);
  });
});

describe("scopeSentences", () => {
  test("renders sentences, not scope strings", () => {
    expect(sentences("context:read context:write")).toEqual([
      "Read your notes",
      "Create and edit notes",
    ]);
  });

  test("keeps the order the client asked in", () => {
    expect(ids("context:write context:read")).toEqual(["write", "read"]);
  });

  test("every spelling of a scope reaches the same sentence", () => {
    for (const alias of ["read", "context:read", "context.read", "notes:read"]) {
      expect(ids(alias)).toEqual(["read"]);
    }
  });

  test("two spellings of one scope do not print the sentence twice", () => {
    expect(ids("read context:read")).toEqual(["read"]);
  });

  test("no scopes is an empty list, not an invented one", () => {
    expect(scopeSentences("")).toEqual([]);
    expect(scopeSentences([])).toEqual([]);
  });

  // The property that matters most: a grant the screen did not mention is a
  // grant nobody consented to.
  test("nothing a client asks for is dropped", () => {
    const asked = ["context:read", "context:write", "wat:huh", "context:audit"];
    expect(scopeSentences(asked)).toHaveLength(4);
  });

  test("an unrecognised scope says so, and shows the raw string", () => {
    const [line] = scopeSentences("wat:huh");
    expect(line.tone).toBe("unknown");
    expect(line.sentence).toContain("wat:huh");
    expect(line.detail).toContain("Approve only if you know");
  });

  describe("wildcards", () => {
    test("collapse to one line that claims everything", () => {
      const lines = scopeSentences("* context:read");
      expect(lines).toHaveLength(1);
      expect(lines[0].id).toBe("wildcard");
      expect(lines[0].tone).toBe("elevated");
    });

    test("mention that it covers whatever is added later", () => {
      expect(scopeSentences("*")[0].detail).toContain("anything Context adds later");
    });

    test("every spelling of a wildcard collapses", () => {
      for (const alias of ["*", "context:*", "context.*", "all"]) {
        expect(ids(alias)).toEqual(["wildcard"]);
      }
    });
  });

  describe("tone", () => {
    test("reading is plain; changing, deleting, and reaching private are not", () => {
      expect(scopeSentences("context:read")[0].tone).toBe("plain");
      for (const scope of ["context:write", "context:delete", "context:private"]) {
        expect(scopeSentences(scope)[0].tone).toBe("elevated");
      }
    });

    test("team access is plain — it is named people, never the public", () => {
      const [line] = scopeSentences("context:team");
      expect(line.tone).toBe("plain");
      expect(line.detail).toContain("private notes stay invisible");
    });
  });

  test("hasElevatedScope distinguishes a read-only client from a writing one", () => {
    expect(hasElevatedScope(scopeSentences("context:read context:team"))).toBe(false);
    expect(hasElevatedScope(scopeSentences("context:read context:write"))).toBe(true);
    expect(hasElevatedScope(scopeSentences("nonsense"))).toBe(true);
  });
});
