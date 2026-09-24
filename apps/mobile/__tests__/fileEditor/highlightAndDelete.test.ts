/**
 * The mockup's markdown tinting, and the permanent-delete sentence.
 *
 * Split out of `fileEditor.test.ts`; see `fixtures.ts` in this folder.
 */

import { describe, expect, test } from "@jest/globals";
import { describeDeleteForever } from "../../features/console/files/paths";
import { highlightMarkdown } from "../../features/console/files/highlight";

describe("the mockup's markdown tinting", () => {
  test("frontmatter delimiters and keys are tinted, values are not", () => {
    const spans = highlightMarkdown("---\nupdated: 2026-08-26\nstatus: active\n---\n\nbody\n");
    const keyText = spans
      .filter((span) => span.tone === "key")
      .map((span) => span.text)
      .join("");
    expect(keyText).toContain("---");
    expect(keyText).toContain("updated:");
    expect(keyText).toContain("status:");
    expect(keyText).not.toContain("2026-08-26");
  });

  test("a heading is tinted", () => {
    const spans = highlightMarkdown("# Title\n\nbody\n");
    expect(spans.find((span) => span.tone === "heading")?.text).toBe("# Title");
  });

  /** A `---` further down is a horizontal rule, not a second frontmatter block. */
  test("only a leading block counts as frontmatter", () => {
    const spans = highlightMarkdown("body\n\n---\n\nmore\n");
    expect(spans.every((span) => span.tone === undefined)).toBe(true);
  });

  test("plain prose is left alone, and nothing is lost", () => {
    const text = "Just some words.\nAnd a second line.\n";
    const spans = highlightMarkdown(text);
    expect(spans.map((span) => span.text).join("")).toBe(text);
    expect(spans).toHaveLength(1);
  });

  test("round-trips any input exactly", () => {
    for (const text of [
      "",
      "#no space is not a heading\n",
      "---\nonly: one\n",
      "---\na: 1\n---\n# H\n\n## H2\ntext",
    ]) {
      expect(highlightMarkdown(text).map((span) => span.text).join("")).toBe(text);
    }
  });
});

/**
 * What the permanent-delete dialog promises.
 *
 * This is a claim about `functions/lib/fileOps.ts`'s `deletePath`, not a piece
 * of styling, and it was false for as long as the console has existed: the
 * dialog said "there is no copy kept anywhere, and nothing to restore from"
 * while every save of an existing note left the version it replaced in
 * `.history/`, and `deletePath` removed only the live keys. So a note anyone
 * had ever edited kept its content in the customer's bucket after being
 * "permanently" deleted — invisible, because `.history/` is hidden from the
 * file tree and from every gateway tool, which is what made it survive review.
 *
 * `deletePath` purges that history now. These assertions are what stops the
 * sentence drifting back ahead of, or behind, what the backend does.
 */
describe("the permanent-delete sentence", () => {
  test("says the earlier versions go too, because they do", () => {
    const body = describeDeleteForever("1-projects/pay.md", false);
    expect(body).toContain("1-projects/pay.md");
    expect(body).toMatch(/earlier versions/i);
    expect(body).toMatch(/cannot be undone/i);
  });

  test("a folder is described as a folder", () => {
    const body = describeDeleteForever("1-projects", true);
    expect(body).toMatch(/Every file in 1-projects/);
    expect(body).toMatch(/earlier versions/i);
  });

  /**
   * The exact sentence that was wrong, and the shape of it. "No copy kept
   * anywhere" is a claim about the whole bucket, and this product still cannot
   * make it: a note renamed before it was deleted leaves a `.move.md` snapshot
   * under the path it used to have, which `deletePath` never sees. The dialog
   * says what goes *alongside the note*, which is true.
   */
  test("never claims there is no copy anywhere", () => {
    for (const body of [
      describeDeleteForever("1-projects/pay.md", false),
      describeDeleteForever("1-projects", true),
    ]) {
      expect(body).not.toMatch(/no copy/i);
      expect(body).not.toMatch(/nothing to restore/i);
      expect(body).not.toMatch(/no(?:where| copy) kept/i);
    }
  });

  test("still points away from archive rather than pretending this is one", () => {
    expect(describeDeleteForever("1-projects/pay.md", false)).toMatch(/archive/i);
  });

  /**
   * The half that went wrong in the other direction. Once the product tells
   * people to enable versioning as their only protection against a bad
   * overwrite, an unqualified "this cannot be undone" is false for exactly the
   * customers who took that advice — their provider still holds the noncurrent
   * version, and we cannot see or delete it.
   */
  test("does not promise erasure it cannot perform at the provider", () => {
    for (const body of [
      describeDeleteForever("1-projects/pay.md", false),
      describeDeleteForever("1-projects", true),
    ]) {
      expect(body).toMatch(/versioning/i);
      expect(body).toMatch(/only you can remove them/i);
      // Qualified, not absolute: "from here" is the whole point of the fix.
      expect(body).not.toMatch(/cannot be undone[.,]/i);
    }
  });
});
