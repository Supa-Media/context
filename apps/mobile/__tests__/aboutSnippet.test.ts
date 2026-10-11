/**
 * What a folder page shows of its about note under the title
 * (`aboutSnippet.ts`; the owner's redesign of 2026-10-09): the opening
 * words as plain text, and whether there is more to read.
 */

import { describe, expect, test } from "@jest/globals";
import { aboutSnippet } from "../features/console/files/folderPage/aboutSnippet";

describe("a folder about's opening words", () => {
  test("a one-paragraph about is all there is", () => {
    expect(aboutSnippet("Active work with an end state.\n", "Projects")).toEqual({ text: "Active work with an end state.", kind: "paragraph", more: false });
  });

  test("marks and code are words, and a title heading above is not more", () => {
    expect(aboutSnippet("---\nstatus: active\n---\n# Projects home\n\n`1-projects/` holds **active** [work](https://example.invalid).\n", "Projects")).toEqual({
      text: "1-projects/ holds active work.",
      kind: "paragraph",
      more: false,
    });
  });

  test("anything after the opening paragraph is more", () => {
    expect(aboutSnippet("Active work.\n\n## Folder rules\n\n- One folder per project.\n", "Projects")?.more).toBe(true);
    expect(aboutSnippet("Active work.\n\nA second paragraph.\n", "Projects")?.more).toBe(true);
  });

  test("a paragraph too long to keep is cut, and that is more", () => {
    const long = "word ".repeat(120).trim();
    const snippet = aboutSnippet(long, "Projects")!;
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.more).toBe(true);
  });

  test("an about that opens with a list joins its first items", () => {
    expect(aboutSnippet("- [ ] One\n- Two\n", "X")).toEqual({ text: "One · Two", kind: "list", more: false });
    expect(aboutSnippet("# Rules\n\n1. A\n2. B\n3. C\n4. D\n5. E\n", "X")).toEqual({ text: "A · B · C · D…", kind: "list", more: true });
  });

  test("only headings: the first one, as words", () => {
    expect(aboutSnippet("## Budget\n\n## People\n", "X")).toEqual({ text: "Budget", kind: "heading", more: true });
  });

  test("nothing readable is said to be more, and an empty note is nothing", () => {
    expect(aboutSnippet("| a | b |\n|---|---|\n", "X")).toEqual({ text: "", kind: "other", more: true });
    expect(aboutSnippet("", "X")).toBeNull();
    expect(aboutSnippet("---\ntags: [x]\n---\n\n", "X")).toBeNull();
    expect(aboutSnippet("# X\n", "X")).toBeNull();
  });

  test("a fenced block is not read as a list or a paragraph", () => {
    expect(aboutSnippet("```\n- not an item\n```\n\nThe words.\n", "X")).toEqual({ text: "The words.", kind: "paragraph", more: true });
  });
});
