/**
 * The strength feedback on the "Lock this note" screen.
 *
 * The one hard requirement is the floor itself — `MINIMUM_PASSPHRASE_LENGTH`
 * in `passphraseOps.ts` — and this file's first job is proving the feedback
 * module's own copy of that number cannot silently drift from it. Everything
 * after that is feedback, not a gate, so these tests pin *bands* rather than
 * exact scores: the estimate is coarse on purpose and a test that pinned exact
 * output would be re-litigating the heuristic instead of the property that
 * matters — long and varied never reads weaker than short and plain.
 */
import { describe, expect, test } from "@jest/globals";
import { MINIMUM_PASSPHRASE_LENGTH } from "../features/console/encryption/passphraseOps";
import { passphraseStrength } from "../features/console/encryption/strength";

describe("the floor", () => {
  test("below MINIMUM_PASSPHRASE_LENGTH is always tooShort, and only there", () => {
    for (let length = 0; length < MINIMUM_PASSPHRASE_LENGTH; length += 1) {
      expect(passphraseStrength("a".repeat(length)).strength).toBe("tooShort");
    }
    // At the floor, a highly repetitive passphrase is weak rather than
    // tooShort — the two are different failures and must not be conflated.
    expect(passphraseStrength("a".repeat(MINIMUM_PASSPHRASE_LENGTH)).strength).not.toBe(
      "tooShort",
    );
  });

  test("the sentence names how many characters are still needed", () => {
    const { label } = passphraseStrength("short");
    expect(label).toContain(`${MINIMUM_PASSPHRASE_LENGTH - 5}`);
  });
});

describe("above the floor", () => {
  test("a highly repetitive passphrase is weak even though it clears the floor", () => {
    expect(passphraseStrength("aaaaaaaaaaaaaaaaaaaa").strength).toBe("weak");
  });

  test("a long multi-word passphrase in one character class is at least fair", () => {
    const { strength } = passphraseStrength("correct horse battery staple");
    expect(["fair", "strong"]).toContain(strength);
  });

  test("a very long passphrase reads as strong even with no symbols or digits", () => {
    const { strength } = passphraseStrength("the quick brown fox jumps over lazy dogs today");
    expect(strength).toBe("strong");
  });

  test("length compensates for variety: a long plain phrase beats a short mixed one", () => {
    const long = passphraseStrength("seventeen wandering pelicans dream quietly");
    const short = passphraseStrength("aA1!aA1!aA1!");
    const rank: Record<string, number> = { tooShort: 0, weak: 1, fair: 2, strong: 3 };
    expect(rank[long.strength]).toBeGreaterThanOrEqual(rank[short.strength]);
  });

  test("never claims strength it has not earned: nothing is 'strong' below 20 characters", () => {
    for (let length = MINIMUM_PASSPHRASE_LENGTH; length < 20; length += 1) {
      // Maximum variety, still short.
      const passphrase = ("aA1!".repeat(6)).slice(0, length);
      expect(passphraseStrength(passphrase).strength).not.toBe("strong");
    }
  });
});
