import { describe, expect, test } from "vitest";
import { THREE_WORD_LIST, threeWords } from "../functions/lib/threeWords";

/** The three-word names a group chat's home is filed under (`lib/textGroupHome.ts`). Moved here from `textGroupGuests.test.ts` when guest mode was retired. */
describe("three words", () => {
  test("three different words from the list, joined by hyphens", () => {
    let i = 0;
    const steps = [0, 0, 0.5, 0.9999];
    expect(threeWords(() => steps[i++]!)).toBe(`${THREE_WORD_LIST[0]}-${THREE_WORD_LIST[Math.floor(0.5 * THREE_WORD_LIST.length)]}-${THREE_WORD_LIST.at(-1)}`);
    for (const word of THREE_WORD_LIST) expect(word).toMatch(/^[a-z]{2,8}$/);
    expect(new Set(THREE_WORD_LIST).size).toBe(THREE_WORD_LIST.length);
  });
});
