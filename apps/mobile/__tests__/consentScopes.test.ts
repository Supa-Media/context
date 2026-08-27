import { describe, expect, test } from "@jest/globals";
import {
  clampScopes,
  grantableTiers as backendGrantableTiers,
  SCOPE_CAPTURE,
  SCOPE_PRIVATE,
  SCOPE_READ,
  SCOPE_WRITE,
} from "@context/convex/functions/lib/consentScopes";
import {
  grantableTiers,
  hasElevatedScope,
  isTierScope,
  normalizeScopes,
  roleCanGrantScope,
  scopeSentences,
  tierCeilingForRole,
} from "../features/consent/scopes";

/**
 * The consent screen's whole job is to let someone weigh what they are handing
 * over. These tests exist to make four properties non-negotiable:
 *
 *  1. Nothing a client asked for is dropped from the list.
 *  2. A wildcard is never described as anything narrower than everything.
 *  3. A scope we cannot describe is *said* to be one, rather than being
 *     silently omitted or folded into a reassuring summary.
 *  4. No sentence describes a grant as narrower than the tier being granted
 *     makes it. See "what the read line promises" below.
 *  5. No control is offered that the backend will refuse. The last block
 *     imports the control plane's own clamp and asserts this file agrees with
 *     it, so the mirror is checked rather than claimed.
 */

/**
 * The tier most of these cases do not care about.
 *
 * `team` rather than `private` on purpose: it is the tier whose sentences are
 * about the shape of the list rather than about privacy, so a future change to
 * the private wording cannot quietly rewrite what these tests mean.
 */
const TEAM = "team" as const;

const ids = (scopes: string | string[], tier: "private" | "team" | "unknown" = TEAM) =>
  scopeSentences(scopes, tier).map((line) => line.id);
const sentences = (scopes: string | string[], tier: "private" | "team" | "unknown" = TEAM) =>
  scopeSentences(scopes, tier).map((line) => line.sentence);

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
    expect(scopeSentences("", TEAM)).toEqual([]);
    expect(scopeSentences([], TEAM)).toEqual([]);
  });

  // The property that matters most: a grant the screen did not mention is a
  // grant nobody consented to.
  test("nothing a client asks for is dropped", () => {
    const asked = ["context:read", "context:write", "wat:huh", "context:audit"];
    expect(scopeSentences(asked, TEAM)).toHaveLength(4);
  });

  test("an unrecognised scope says so, and shows the raw string", () => {
    const [line] = scopeSentences("wat:huh", TEAM);
    expect(line.tone).toBe("unknown");
    expect(line.sentence).toContain("wat:huh");
    expect(line.detail).toContain("Approve only if you know");
  });

  describe("wildcards", () => {
    test("collapse to one line that claims everything", () => {
      const lines = scopeSentences("* context:read", TEAM);
      expect(lines).toHaveLength(1);
      expect(lines[0].id).toBe("wildcard");
      expect(lines[0].tone).toBe("elevated");
    });

    test("mention that it covers whatever is added later", () => {
      expect(scopeSentences("*", TEAM)[0].detail).toContain("anything Context adds later");
    });

    test("every spelling of a wildcard collapses", () => {
      for (const alias of ["*", "context:*", "context.*", "all"]) {
        expect(ids(alias)).toEqual(["wildcard"]);
      }
    });
  });

  describe("tone", () => {
    test("reading is plain for a member; changing, deleting, and reaching private are not", () => {
      expect(scopeSentences("context:read", TEAM)[0].tone).toBe("plain");
      for (const scope of ["context:write", "context:delete", "context:private"]) {
        expect(scopeSentences(scope, TEAM)[0].tone).toBe("elevated");
      }
    });

    test("team access is plain — it is named people, never the public", () => {
      const [line] = scopeSentences("context:team", TEAM);
      expect(line.tone).toBe("plain");
      expect(line.detail).toContain("private notes stay invisible");
    });
  });

  test("hasElevatedScope distinguishes a read-only client from a writing one", () => {
    expect(hasElevatedScope(scopeSentences("context:read context:team", TEAM))).toBe(false);
    expect(hasElevatedScope(scopeSentences("context:read context:write", TEAM))).toBe(true);
    expect(hasElevatedScope(scopeSentences("nonsense", TEAM))).toBe(true);
  });
});

/**
 * What the read line promises, at each tier.
 *
 * The bug these pin: the read line used to promise "Everything in this context
 * except notes you marked private" to every approver, keyed off nothing but the
 * *role*. For an owner that was the opposite of what happened — the gateway
 * derived the tier from membership, so an owner's grant always reached every
 * private note, under a sentence swearing it would not.
 *
 * The sentence is keyed off the tier now, and the tier is something the person
 * chose and the grant records. That is what makes both readings honest instead
 * of one of them being a lie about the other.
 *
 * These tests are the contract, not the wording: they assert on what is
 * *claimed*, so a rewrite that stays true stays green and a rewrite that
 * reintroduces the promise does not.
 */
describe("the read line tells the truth about the tier being granted", () => {
  const readDetail = (tier: "private" | "team" | "unknown") => {
    const [line] = scopeSentences("context:read", tier);
    return line.detail ?? "";
  };

  test("at private tier, private notes are said to be included, in the elevated tone", () => {
    const [line] = scopeSentences("context:read", "private");
    expect(line.detail).toMatch(/including/i);
    expect(line.detail).toMatch(/private/i);
    expect(line.tone).toBe("elevated");
  });

  test("at private tier, nothing is ever described as excluded", () => {
    // The exact shape of the old lie, and any paraphrase of it.
    expect(readDetail("private")).not.toMatch(/\bexcept\b/i);
    expect(readDetail("private")).not.toMatch(/\bother than\b/i);
    expect(readDetail("private")).not.toMatch(/stays? (?:invisible|hidden|private)/i);
  });

  test("at team tier, private notes are said to be excluded, in the plain tone", () => {
    const [line] = scopeSentences("context:read", "team");
    expect(line.detail).toMatch(/except/i);
    expect(line.detail).toMatch(/private/i);
    expect(line.tone).toBe("plain");
  });

  test("the two tiers are not told the same thing", () => {
    expect(readDetail("private")).not.toBe(readDetail("team"));
  });

  test("no tier yet — because no context is picked — claims no exclusion either", () => {
    const [line] = scopeSentences("context:read", "unknown");
    expect(line.detail).not.toMatch(/\bexcept\b/i);
    // Unknown means we cannot promise the narrow reading, so it reads loud.
    expect(line.tone).toBe("elevated");
  });

  test("a private-tier read-only grant is elevated, so the screen says the loud thing", () => {
    expect(hasElevatedScope(scopeSentences("context:read", "private"))).toBe(true);
    expect(hasElevatedScope(scopeSentences("context:read", "team"))).toBe(false);
  });
});

/**
 * The screen's offer, checked against the backend's clamp.
 *
 * This file used to *say* it mirrored `visibilityTierForRole` in the gateway,
 * and nothing checked it. "A guard nobody has checked is not a guard": the real
 * authority is `functions/lib/consentScopes.ts`, so this imports it and asserts
 * agreement, role by role and scope by scope. A control the backend would strip
 * is a control that must not be drawn.
 */
describe("the screen offers exactly what the control plane will accept", () => {
  const ROLES = ["owner", "editor", "member"];
  const OPERATIONS = [SCOPE_READ, SCOPE_WRITE, SCOPE_CAPTURE];

  test("every operation this file would offer survives the backend clamp", () => {
    for (const role of ROLES) {
      for (const scope of OPERATIONS) {
        // The label rides in the assertion rather than in a message argument:
        // jest's `expect` takes one.
        expect([role, scope, roleCanGrantScope(role, scope)]).toEqual([
          role,
          scope,
          clampScopes([scope], role).includes(scope),
        ]);
      }
    }
  });

  test("and every operation it withholds is one the backend would strip", () => {
    expect(roleCanGrantScope("member", SCOPE_WRITE)).toBe(false);
    expect(clampScopes([SCOPE_WRITE], "member")).toEqual([]);
  });

  test("the tiers offered match the tiers the backend would honour", () => {
    for (const role of ROLES) {
      expect([role, grantableTiers(role)]).toEqual([role, backendGrantableTiers(role)]);
    }
  });

  test("only an owner is offered private-tier, on both sides", () => {
    expect(tierCeilingForRole("owner")).toBe("private");
    expect(tierCeilingForRole("editor")).toBe("team");
    expect(tierCeilingForRole("member")).toBe("team");
    expect(tierCeilingForRole(null)).toBe("unknown");
    expect(tierCeilingForRole("something-new")).toBe("unknown");

    expect(clampScopes([SCOPE_PRIVATE], "owner")).toEqual([SCOPE_PRIVATE]);
    for (const role of ["editor", "member"]) {
      expect(clampScopes([SCOPE_PRIVATE], role)).toEqual([]);
      expect(roleCanGrantScope(role, SCOPE_PRIVATE)).toBe(false);
    }
  });

  test("every spelling this screen reads as the tier is one the backend strips", () => {
    // The screen renders any of these as private access, so a member's grant
    // carrying one would make the console say "Full access" for somebody who
    // has not got it.
    for (const spelling of ["context:private", "context.private", "private", "*"]) {
      expect([spelling, isTierScope(spelling)]).toEqual([spelling, true]);
      expect([spelling, clampScopes([spelling], "member")]).toEqual([spelling, []]);
    }
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
