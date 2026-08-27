import { describe, expect, test } from "@jest/globals";
import {
  hasElevatedScope,
  normalizeScopes,
  scopeSentences,
  visibilityTierForRole,
} from "../features/consent/scopes";

/**
 * The consent screen's whole job is to let someone weigh what they are handing
 * over. These tests exist to make four properties non-negotiable:
 *
 *  1. Nothing a client asked for is dropped from the list.
 *  2. A wildcard is never described as anything narrower than everything.
 *  3. A scope we cannot describe is *said* to be one, rather than being
 *     silently omitted or folded into a reassuring summary.
 *  4. No sentence describes a grant as narrower than the approver's own role
 *     makes it. See "what an owner is told" below.
 */

/**
 * The role most of these cases do not care about.
 *
 * `member` rather than `owner` on purpose: it is the tier whose sentences are
 * about the shape of the list rather than about privacy, so a future change to
 * the owner wording cannot quietly rewrite what these tests mean.
 */
const MEMBER = "member";

const ids = (scopes: string | string[], role: string | null = MEMBER) =>
  scopeSentences(scopes, role).map((line) => line.id);
const sentences = (scopes: string | string[], role: string | null = MEMBER) =>
  scopeSentences(scopes, role).map((line) => line.sentence);

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
    expect(scopeSentences("", MEMBER)).toEqual([]);
    expect(scopeSentences([], MEMBER)).toEqual([]);
  });

  // The property that matters most: a grant the screen did not mention is a
  // grant nobody consented to.
  test("nothing a client asks for is dropped", () => {
    const asked = ["context:read", "context:write", "wat:huh", "context:audit"];
    expect(scopeSentences(asked, MEMBER)).toHaveLength(4);
  });

  test("an unrecognised scope says so, and shows the raw string", () => {
    const [line] = scopeSentences("wat:huh", MEMBER);
    expect(line.tone).toBe("unknown");
    expect(line.sentence).toContain("wat:huh");
    expect(line.detail).toContain("Approve only if you know");
  });

  describe("wildcards", () => {
    test("collapse to one line that claims everything", () => {
      const lines = scopeSentences("* context:read", MEMBER);
      expect(lines).toHaveLength(1);
      expect(lines[0].id).toBe("wildcard");
      expect(lines[0].tone).toBe("elevated");
    });

    test("mention that it covers whatever is added later", () => {
      expect(scopeSentences("*", MEMBER)[0].detail).toContain("anything Context adds later");
    });

    test("every spelling of a wildcard collapses", () => {
      for (const alias of ["*", "context:*", "context.*", "all"]) {
        expect(ids(alias)).toEqual(["wildcard"]);
      }
    });
  });

  describe("tone", () => {
    test("reading is plain for a member; changing, deleting, and reaching private are not", () => {
      expect(scopeSentences("context:read", MEMBER)[0].tone).toBe("plain");
      for (const scope of ["context:write", "context:delete", "context:private"]) {
        expect(scopeSentences(scope, MEMBER)[0].tone).toBe("elevated");
      }
    });

    test("team access is plain — it is named people, never the public", () => {
      const [line] = scopeSentences("context:team", MEMBER);
      expect(line.tone).toBe("plain");
      expect(line.detail).toContain("private notes stay invisible");
    });
  });

  test("hasElevatedScope distinguishes a read-only client from a writing one", () => {
    expect(hasElevatedScope(scopeSentences("context:read context:team", MEMBER))).toBe(false);
    expect(hasElevatedScope(scopeSentences("context:read context:write", MEMBER))).toBe(true);
    expect(hasElevatedScope(scopeSentences("nonsense", MEMBER))).toBe(true);
  });
});

/**
 * What an owner is told, versus what everybody else is told.
 *
 * The bug these pin: the read line used to promise "Everything in this context
 * except notes you marked private" to every approver. For an owner that is the
 * opposite of what happens — `visibilityTierForRole` gives an owner's grant the
 * `private` tier, at which the gateway's `canSee` returns true for every key.
 * So the default grant on the default account handed an AI client every private
 * note under a sentence swearing it would not.
 *
 * These tests are the contract, not the wording: they assert on what is
 * *claimed*, so a rewrite that stays true stays green and a rewrite that
 * reintroduces the promise does not.
 */
describe("the read line tells the truth about who is approving", () => {
  const readDetail = (role: string | null) => {
    const [line] = scopeSentences("context:read", role);
    return line.detail ?? "";
  };

  test("an owner is told their private notes are included, in the elevated tone", () => {
    const [line] = scopeSentences("context:read", "owner");
    expect(line.detail).toMatch(/including/i);
    expect(line.detail).toMatch(/private/i);
    expect(line.tone).toBe("elevated");
  });

  test("an owner is never told anything is excluded", () => {
    // The exact shape of the old lie, and any paraphrase of it.
    expect(readDetail("owner")).not.toMatch(/\bexcept\b/i);
    expect(readDetail("owner")).not.toMatch(/\bother than\b/i);
    expect(readDetail("owner")).not.toMatch(/stays? (?:invisible|hidden|private)/i);
  });

  test("an editor and a member are told private notes are excluded, in the plain tone", () => {
    for (const role of ["editor", "member"]) {
      const [line] = scopeSentences("context:read", role);
      expect(line.detail).toMatch(/except/i);
      expect(line.detail).toMatch(/private/i);
      expect(line.tone).toBe("plain");
    }
  });

  test("an owner and a member are not told the same thing", () => {
    expect(readDetail("owner")).not.toBe(readDetail("member"));
  });

  test("no role yet — because no context is picked — claims no exclusion either", () => {
    for (const role of [null, undefined, "some-role-we-shipped-later"]) {
      const [line] = scopeSentences("context:read", role);
      expect(line.detail).not.toMatch(/\bexcept\b/i);
      // Unknown means we cannot promise the narrow reading, so it reads loud.
      expect(line.tone).toBe("elevated");
    }
  });

  test("an owner's read-only grant counts as elevated, so the screen says the loud thing", () => {
    expect(hasElevatedScope(scopeSentences("context:read", "owner"))).toBe(true);
    expect(hasElevatedScope(scopeSentences("context:read", "member"))).toBe(false);
  });

  /**
   * The mapping this whole file leans on. It mirrors `visibilityTierForRole` in
   * `apps/mcp/src/session.js`; if that changes and this does not, the sentences
   * above become false again.
   */
  test("the tier mapping matches the gateway's", () => {
    expect(visibilityTierForRole("owner")).toBe("private");
    expect(visibilityTierForRole("editor")).toBe("team");
    expect(visibilityTierForRole("member")).toBe("team");
    expect(visibilityTierForRole(null)).toBe("unknown");
    expect(visibilityTierForRole("something-new")).toBe("unknown");
  });
});

/**
 * Every scope the server advertises must have a description.
 *
 * `context:capture` is in `SUPPORTED_SCOPES`, is published in both discovery
 * documents, and `/oauth/authorize` rejects anything outside that set — so it
 * is a scope a client is *expected* to ask for. It had no entry here, so it
 * fell to the unknown-scope fallback and the consent screen told the owner:
 *
 *   "Something this version of Context can't describe: context:capture
 *    Approve only if you know what this client is asking for."
 *
 * A red flag on the one thing guaranteed to appear teaches people to click
 * through warnings, which is the opposite of what a consent screen is for.
 */
describe("every advertised scope is described", () => {
  // Mirrors SUPPORTED_SCOPES in apps/mcp/src/session.js. If the gateway grows
  // a scope, this list and SCOPE_ALIASES must both grow with it.
  const ADVERTISED = ["context:read", "context:write", "context:capture"];

  for (const scope of ADVERTISED) {
    test(`${scope} is not shown as undescribable`, () => {
      const [line] = scopeSentences([scope], "owner");
      expect(line.sentence).not.toMatch(/can't describe|cannot describe/i);
      expect(line.sentence.length).toBeGreaterThan(0);
    });
  }
});
