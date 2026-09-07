import { describe, expect, test } from "@jest/globals";
import { splitParagraphs, tokenizeInline } from "../features/console/communications/markdownInline";

describe("splitParagraphs", () => {
  test("splits on a blank line", () => {
    expect(splitParagraphs("one\n\ntwo")).toEqual(["one", "two"]);
  });

  test("collapses several blank lines into one break", () => {
    expect(splitParagraphs("one\n\n\n\ntwo")).toEqual(["one", "two"]);
  });

  test("trims and drops empty paragraphs", () => {
    expect(splitParagraphs("  one  \n\n\n\n  ")).toEqual(["one"]);
  });

  test("a single line is one paragraph", () => {
    expect(splitParagraphs("just one line")).toEqual(["just one line"]);
  });
});

describe("tokenizeInline", () => {
  test("plain text is one token", () => {
    expect(tokenizeInline("hello")).toEqual([{ text: "hello" }]);
  });

  test("bold, italic and code are recognised", () => {
    expect(tokenizeInline("**bold**")).toEqual([{ text: "bold", bold: true }]);
    expect(tokenizeInline("*italic*")).toEqual([{ text: "italic", italic: true }]);
    expect(tokenizeInline("`code`")).toEqual([{ text: "code", code: true }]);
  });

  test("text around a mark stays plain", () => {
    expect(tokenizeInline("see **this** now")).toEqual([
      { text: "see " },
      { text: "this", bold: true },
      { text: " now" },
    ]);
  });

  test("empty text is one empty token, never zero tokens", () => {
    expect(tokenizeInline("")).toEqual([{ text: "" }]);
  });

  for (const attack of [
    "[[.audit/anything]]",
    "[click here](https://evil.example/phish)",
    "[[0-inbox/email/other-at-example-com/2026-09-07#msg-0000000000000000|open this]]",
  ]) {
    test(`link and wikilink syntax is never recognised, only carried through as text: ${attack}`, () => {
      const rendered = tokenizeInline(attack)
        .map((token) => token.text)
        .join("");
      expect(rendered).toBe(attack);
      // Not one token happens to carry a link-shaped field — there is no such
      // field on `InlineToken` at all, which is the actual guarantee; this
      // just pins that every character survives untouched as plain text.
      expect(tokenizeInline(attack).every((token) => !token.bold && !token.italic && !token.code)).toBe(
        true,
      );
    });
  }

  test("a bare asterisk with no closing partner is left as plain text, not consumed", () => {
    expect(tokenizeInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6" }]);
  });

  test("marks do not nest, and no character is lost deciding that", () => {
    const input = "**a *b* c**";
    const tokens = tokenizeInline(input);
    // The actual reading — `**` cannot close around an embedded `*`, so the
    // two inner `*b*` runs are read as italic instead, each contributing its
    // marker characters back when reconstructed as plain text plus marks.
    // What this corpus actually needs, per the module's own header, is not
    // *which* reading wins but that none of it is silently dropped:
    const reconstructed = tokens
      .map((token) => (token.bold ? `**${token.text}**` : token.italic ? `*${token.text}*` : token.code ? `\`${token.text}\`` : token.text))
      .join("");
    expect(reconstructed).toBe(input);
  });
});
