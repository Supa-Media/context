import { describe, expect, it } from "vitest";
import { MAX_TEXTS, textsFromAnswer } from "./format";

describe("textsFromAnswer", () => {
  it("strips the Markdown that arrived as punctuation in the owner's first real text", () => {
    const answer =
      "Your brother is **Segun**. He was your best man.\n**[2-areas/family/overview.md](2-areas/family/overview.md)**";
    expect(textsFromAnswer(answer)).toEqual(["Your brother is Segun. He was your best man."]);
  });

  it("leaves plain text alone", () => {
    expect(textsFromAnswer("Segun. He was your best man.")).toEqual(["Segun. He was your best man."]);
  });

  it("drops headings, italics and code ticks but keeps the words", () => {
    expect(textsFromAnswer("## Plan\nShip the *simulator* with `pnpm deploy`, then __rest__.")).toEqual([
      "Plan\nShip the simulator with pnpm deploy, then rest.",
    ]);
  });

  it("does not touch asterisks that are arithmetic or snake_case", () => {
    expect(textsFromAnswer("2 * 3 = 6 and my_var_name stays")).toEqual(["2 * 3 = 6 and my_var_name stays"]);
  });

  it("sends paragraphs as separate texts, keeping a list with its lead line", () => {
    expect(textsFromAnswer("Yeah, it's solid.\n\nFix these first:\n\n* Add the rate\n\n* Finish the sentence")).toEqual([
      "Yeah, it's solid.",
      "Fix these first:\n- Add the rate\n- Finish the sentence",
    ]);
  });

  it("never sends more than a few texts", () => {
    const texts = textsFromAnswer(["one", "two", "three", "four", "five"].join("\n\n"));
    expect(texts).toHaveLength(MAX_TEXTS);
    expect(texts[MAX_TEXTS - 1]).toBe("three\n\nfour\n\nfive");
  });

  it("sends a web link after the answer, as a text of its own, so iMessage draws a card", () => {
    expect(textsFromAnswer("Here's the [week one doc](https://app.example/n/week-one).")).toEqual([
      "Here's the week one doc.",
      "https://app.example/n/week-one",
    ]);
    expect(textsFromAnswer("Open [https://app.example/x](https://app.example/x)")).toEqual([
      "Open",
      "https://app.example/x",
    ]);
  });

  it("moves a link on a line of its own to the end, so Messages draws its card", () => {
    // Folded into a later paragraph, the link ends up mid-text and Messages
    // shows a plain link, or "Tap to Load Preview", instead of the card.
    expect(
      textsFromAnswer(
        "The overview is here:\n\nhttps://context.lc/note/@supa/plan.md\n\nTwo\n\nThree\n\nFour",
      ),
    ).toEqual(["The overview is here:", "Two", "Three\n\nFour", "https://context.lc/note/@supa/plan.md"]);
    expect(textsFromAnswer("Saved.\nlink: https://context.lc/note/@me/a.md")).toEqual([
      "Saved.",
      "https://context.lc/note/@me/a.md",
    ]);
    expect(textsFromAnswer("https://context.lc/note/@me/a.md")).toEqual(["https://context.lc/note/@me/a.md"]);
  });

  it("leaves a link inside a sentence where it is", () => {
    expect(textsFromAnswer("Open https://context.lc/x to sign in.")).toEqual(["Open https://context.lc/x to sign in."]);
  });

  it("never turns a non-https link target into a text of its own", () => {
    expect(textsFromAnswer("See [this](javascript:void) and [that](http://plain.example/x)")).toEqual([
      "See this and that",
    ]);
  });

  it("removes a source line that is only a note path", () => {
    expect(textsFromAnswer("Monday at 10.\n\nSource: 1-projects/hiring/olumide.md")).toEqual(["Monday at 10."]);
  });

  it("falls back to the answer itself rather than sending nothing", () => {
    expect(textsFromAnswer("notes.md")).toEqual(["notes.md"]);
  });
});
