import { describe, expect, test } from "@jest/globals";

import { HERO_LINE_ONE, HERO_LINE_TWO, LANDING_COPY } from "../features/landing/copy";

/**
 * The vocabulary decisions, enforced on the copy they govern.
 *
 * `docs/decisions/vocabulary-and-workspaces.md` settled two things that bind
 * anything a visitor reads, and until now nothing checked either of them —
 * `landing.test.ts` is about sign-in redirects and has never looked at a word
 * on the page.
 *
 * This is the cheapest guard in the repo and the one most likely to catch a
 * real mistake, because copy is what gets edited in a hurry by whoever is
 * closest to a launch.
 */
describe("the landing page obeys the vocabulary decisions", () => {
  test("there is copy to check", () => {
    // A rule applied to an empty list is a rule that always passes.
    expect(LANDING_COPY.length).toBeGreaterThan(3);
    expect(LANDING_COPY.every((line) => line.trim().length > 0)).toBe(true);
  });

  test("the retired noun appears nowhere", () => {
    // "Brain" is retired: no new user-facing copy uses it. Retiring a word
    // does not free its *name* — that is why it stays reserved in
    // `functions/lib/names.ts` — but it is gone from what people read.
    const offenders = LANDING_COPY.filter((line) => /\bbrains?\b/i.test(line));
    expect(offenders).toEqual([]);
  });

  test("'context' is never used for a single unit", () => {
    // Context is the aggregate and the product name. A single unit is a
    // **workspace**. So "your context" (the whole of what you can reach) is
    // allowed and "a context" / "two contexts" / "this context" are not.
    const asAUnit = /\b(a|an|another|each|every|this|that|these|those|\d+)\s+contexts?\b|\bcontexts\b/i;
    const offenders = LANDING_COPY.filter((line) => asAUnit.test(line));
    expect(offenders).toEqual([]);
  });

  test("the hero says what the product is, not how it is plumbed", () => {
    // The hero used to lead with the endpoint and a list of the assistants it
    // reaches, which asks a reader to know what MCP is before it tells them
    // what they are looking at. Whatever the words become, the first line is
    // about the thing, and the plumbing is not in it.
    const hero = `${HERO_LINE_ONE} ${HERO_LINE_TWO}`;
    expect(hero).toMatch(/notes/i);
    expect(hero).not.toMatch(/\bMCP\b|endpoint|bucket|markdown/i);
  });
});
