/**
 * THE TYPE-IN TIMING, PURE.
 *
 * A Tex text that arrives in a session types in word by word at the mock's
 * 22 ms a word; these tests pin the word count at each moment and that the
 * whole text shows once every word is in.
 */

import { describe, expect, test } from "@jest/globals";
import { REVEAL_MS_PER_WORD, revealChunks, revealedText, revealedWords } from "../features/tex/chat/appChatReveal";

describe("revealedWords", () => {
  test("the first word is there at once", () => {
    expect(revealedWords(5, 0)).toBe(1);
  });

  test("one more word every 22 ms", () => {
    expect(revealedWords(5, REVEAL_MS_PER_WORD - 1)).toBe(1);
    expect(revealedWords(5, REVEAL_MS_PER_WORD)).toBe(2);
    expect(revealedWords(5, REVEAL_MS_PER_WORD * 3)).toBe(4);
  });

  test("never more than the words there are", () => {
    expect(revealedWords(3, 10_000)).toBe(3);
  });

  test("no words, no words shown; a bad clock reads as the first word", () => {
    expect(revealedWords(0, 500)).toBe(0);
    expect(revealedWords(4, -20)).toBe(1);
    expect(revealedWords(4, Number.NaN)).toBe(1);
  });
});

describe("revealedText", () => {
  const text = "Here is the note you asked for.";

  test("grows one word at a time from the front", () => {
    expect(revealedText(text, 0)).toBe("Here ");
    expect(revealedText(text, REVEAL_MS_PER_WORD)).toBe("Here is ");
    expect(revealedText(text, REVEAL_MS_PER_WORD * 2)).toBe("Here is the ");
  });

  test("shows the whole text, spacing and all, once every word is in", () => {
    expect(revealedText(text, 60_000)).toBe(text);
  });

  test("an empty text stays empty", () => {
    expect(revealedText("", 100)).toBe("");
  });

  test("chunks keep the whitespace after each word", () => {
    expect(revealChunks("a  b c")).toEqual(["a  ", "b ", "c"]);
  });
});
