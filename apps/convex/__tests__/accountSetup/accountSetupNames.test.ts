import { describe, expect, test } from "vitest";
import { slugBase, suggestedNameFor } from "../../functions/lib/accountSetup";

/**
 * The pure half of account setup (`functions/lib/accountSetup.ts`): the name
 * a person is offered, and the slug a personal workspace starts from.
 */

describe("the suggested name", () => {
  test("the name the account already has wins", () => {
    expect(suggestedNameFor("Ada Okafor", "ada.okafor@example.org")).toBe("Ada Okafor");
  });

  test("otherwise the email's local part, dots and underscores as spaces, each word capitalised", () => {
    expect(suggestedNameFor(undefined, "ada.okafor@example.org")).toBe("Ada Okafor");
    expect(suggestedNameFor(undefined, "ada_okafor@example.org")).toBe("Ada Okafor");
    expect(suggestedNameFor(undefined, "ada..okafor@example.org")).toBe("Ada Okafor");
  });

  test("a blank name counts as no name", () => {
    expect(suggestedNameFor("   ", "ada@example.org")).toBe("Ada");
  });

  test("nothing to go on gives the empty string", () => {
    expect(suggestedNameFor(undefined, null)).toBe("");
    expect(suggestedNameFor(undefined, "@example.org")).toBe("");
  });
});

describe("the slug base", () => {
  test("lower case, runs of other characters become one hyphen, no hyphen at either end", () => {
    expect(slugBase("Ada Okafor")).toBe("ada-okafor");
    expect(slugBase("  Ada   O'Neil-Smith! ")).toBe("ada-o-neil-smith");
  });

  test("a name with nothing usable in it falls back to a fixed stem", () => {
    expect(slugBase("!!!")).toBe("person");
    expect(slugBase("日本")).toBe("person");
  });

  test("never longer than the name limit, and never ending in a hyphen", () => {
    const slug = slugBase("a".repeat(31) + " b");
    expect(slug.length).toBeLessThanOrEqual(32);
    expect(slug.endsWith("-")).toBe(false);
  });
});
