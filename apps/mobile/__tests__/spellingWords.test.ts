/**
 * SPELLING: WHAT IS A WORD, AND WHAT MIGHT IT HAVE MEANT.
 *
 * The two pure halves of the note editor's checker (Dev2, 2026-10-27, board 5):
 * `words.ts` decides which runs of a line are prose worth spelling, and
 * `engine.ts` answers against a real Hunspell dictionary — the same files the
 * app serves — so a suggestion asserted here is one a person would see.
 *
 * ## Sabotage record
 *
 *   drop NOT_PROSE (every chunk is prose)              1 fail
 *   drop the acronym rule in worthSpelling              1 fail
 *   drop the one-key-away pass in suggest               3 fail
 */

import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSpeller } from "../features/console/files/spelling/engine";
import { noteLinkRanges, wordsIn, worthSpelling } from "../features/console/files/spelling/words";

const words = (line: string) => wordsIn(line).map((word) => word.word);

describe("which text is prose", () => {
  test("plain words, with their punctuation and emphasis taken off", () => {
    expect(words('I\'d like **more** research, (honestly) on "the" wilderness.')).toEqual([
      "I'd", "like", "more", "research", "honestly", "on", "the", "wilderness",
    ]);
  });

  test("a range points at the word in the line, offset by where the line starts", () => {
    const [word] = wordsIn("  **israelites**", 100);
    expect(word).toEqual({ from: 104, to: 114, word: "israelites" });
  });

  test("addresses, handles, tags, paths, numbers and identifiers are not prose", () => {
    expect(words("see https://context.lc and @seyi #launch notes/plan.md v2 words2go snake_case a=b e.g. ok")).toEqual([
      "see", "and", "ok",
    ]);
  });

  test("a link's text is checked and its address is not", () => {
    expect(words("read [the plan](notes/plan.md) today")).toEqual(["read", "the", "plan", "today"]);
  });

  test("acronyms, inner capitals and single letters are left alone", () => {
    expect(words("NASA and GitHub and useState and I")).toEqual(["and", "and", "and"]);
    expect(worthSpelling("PR")).toBe(false);
    expect(worthSpelling("Thursday")).toBe(true);
  });

  test("a hyphenated compound is checked part by part, and a curly apostrophe is made straight", () => {
    expect(wordsIn("well-known don’t").map((w) => w.word)).toEqual(["well", "known", "don't"]);
  });

  test("note links are found so the caller can skip them", () => {
    expect(noteLinkRanges("see [[exodus study]] now", 10)).toEqual([{ from: 14, to: 30 }]);
  });
});

describe("the dictionary", () => {
  const dictionary = path.join(__dirname, "..", "node_modules", "dictionary-en");
  const speller = createSpeller(
    readFileSync(path.join(dictionary, "index.aff"), "utf8"),
    readFileSync(path.join(dictionary, "index.dic"), "utf8"),
  );

  test("accepts real words, a capital at the start of a sentence, and contractions", () => {
    for (const word of ["wandering", "Wandering", "Thursday", "don't", "iPhone"]) {
      expect(speller.correct(word)).toBe(true);
    }
  });

  test("the commonest slip comes first: two letters swapped, a letter missing", () => {
    expect(speller.suggest("teh")[0]).toBe("the");
    expect(speller.suggest("recieve")[0]).toBe("receive");
    expect(speller.suggest("elevn")[0]).toBe("eleven");
  });

  test("a suggestion keeps the capital the word was typed with, and a name keeps its own", () => {
    expect(speller.suggest("Recieve")[0]).toBe("Receive");
    expect(speller.suggest("thursday")[0]).toBe("Thursday");
  });

  test("a correct word has nothing to suggest, and a list is at most five long", () => {
    expect(speller.suggest("wandering")).toEqual([]);
    expect(speller.suggest("teh").length).toBeLessThanOrEqual(5);
  });

  test("a possessive is wrong exactly when the word under it is", () => {
    expect(speller.correct("Israelite's")).toBe(true);
    expect(speller.correct("permissoning's")).toBe(false);
  });
});
