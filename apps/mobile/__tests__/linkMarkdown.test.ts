/**
 * THE LINK SHEET'S TEXT: WHAT IS OFFERED FOR WHAT IS TYPED, AND WHAT A PICK
 * WRITES OVER THE SELECTED WORDS.
 *
 * The owner selected words, pressed the link key and lost them; the ask was
 * "link to an external webpage, internal note or freeform text". So three
 * kinds of link, one field, and every output here has to be a link the rest
 * of the app reads back as one — which is why each form is round-tripped
 * through `parseLinks`, the shared parser every reader uses. A link written
 * in a shape `parseLinks` does not accept looks like a link to the person who
 * made it and is plain text to everybody after them.
 */

import { describe, expect, test } from "@jest/globals";
import { parseLinks } from "@context/shared/src/links";
import {
  decodeLinkTarget,
  freeTextTarget,
  linkableLabel,
  linkMarkdown,
  linkRows,
  SHEET_NOTE_ROWS,
  webPageAddress,
} from "../features/console/files/linkMarkdown";

const PATHS = [
  "1-projects/launch-plan.md",
  "2-areas/ops/launch-checklist.md",
  "2-areas/weekly-review.md",
  "3-resources/relaunch.md",
  "overview.md",
];

describe("which text is a web page", () => {
  test.each([
    ["https://example.com/launch", "https://example.com/launch"],
    ["http://example.com", "http://example.com"],
    ["example.com", "https://example.com"],
    ["www.example.org/a?b=c", "https://www.example.org/a?b=c"],
    ["  https://example.com  ", "https://example.com"],
  ])("%s is %s", (typed, url) => {
    expect(webPageAddress(typed)).toBe(url);
  });

  test.each([
    "launch",
    "launch plan",
    "report.pdf",
    "someone@example.com",
    "javascript:alert(1)",
    "https://user@example.com",
    "ftp://example.com",
    "",
  ])("%s is not", (typed) => {
    expect(webPageAddress(typed)).toBeNull();
  });
});

describe("what each kind of link writes", () => {
  test("a web page: [words](address)", () => {
    const out = linkMarkdown("the launch plan", { kind: "url", url: "https://example.com/launch" });
    expect(out).toBe("[the launch plan](https://example.com/launch)");
    expect(parseLinks(out)).toEqual([expect.objectContaining({ kind: "inline", target: "https://example.com/launch" })]);
  });

  test("a note: [[target|words]], with the target `[[` completion writes", () => {
    const out = linkMarkdown("the launch plan", { kind: "note", target: "1-projects/launch-plan" });
    expect(out).toBe("[[1-projects/launch-plan|the launch plan]]");
    expect(parseLinks(out)).toEqual([expect.objectContaining({ kind: "wiki", target: "1-projects/launch-plan" })]);
  });

  test("free text: [[typed|words]], a note that may not exist yet", () => {
    const out = linkMarkdown("the launch plan", { kind: "note", target: "launch" });
    expect(out).toBe("[[launch|the launch plan]]");
    expect(parseLinks(out)).toEqual([expect.objectContaining({ kind: "wiki", target: "launch" })]);
  });

  test("words that are the target are not written twice", () => {
    expect(linkMarkdown("launch", { kind: "note", target: "launch" })).toBe("[[launch]]");
  });

  test("whitespace at either end of the selection stays outside the link", () => {
    expect(linkMarkdown(" plan ", { kind: "url", url: "https://example.com" })).toBe(" [plan](https://example.com) ");
    expect(linkMarkdown("plan ", { kind: "note", target: "a" })).toBe("[[a|plan]] ");
  });

  test("an address with parentheses still parses as one link, to the same address", () => {
    const out = linkMarkdown("wiki", { kind: "url", url: "https://example.com/Foo_(bar)" });
    expect(out).toBe("[wiki](https://example.com/Foo_%28bar%29)");
    expect(parseLinks(out)).toEqual([expect.objectContaining({ target: "https://example.com/Foo_%28bar%29" })]);
  });
});

describe("which selections can become a link's words", () => {
  test.each(["the launch plan", "**bold** words", "a|b", " spaced "])("%j can", (text) => {
    expect(linkableLabel(text)).toBe(true);
  });

  // Neither form survives these: `parseLinks` reads `[^\]\n]` for both.
  test.each(["two\nlines", "a [bracket]", "a ] b", "   ", ""])("%j cannot", (text) => {
    expect(linkableLabel(text)).toBe(false);
  });
});

describe("a typed name as a wikilink target", () => {
  test("keeps the words and drops what a target cannot hold", () => {
    expect(freeTextTarget("  launch   plan ")).toBe("launch plan");
    expect(freeTextTarget("a|b]c[d")).toBe("abcd");
    expect(freeTextTarget("[]|")).toBeNull();
  });
});

describe("a link off the bridge", () => {
  test("is accepted only in a shape the sheet could have produced", () => {
    expect(decodeLinkTarget({ kind: "url", url: "https://example.com" })).toEqual({ kind: "url", url: "https://example.com" });
    expect(decodeLinkTarget({ kind: "note", target: "1-projects/a" })).toEqual({ kind: "note", target: "1-projects/a" });
    // Not an address `webPageAddress` returns as-is: refused, not repaired.
    expect(decodeLinkTarget({ kind: "url", url: "javascript:alert(1)" })).toBeNull();
    expect(decodeLinkTarget({ kind: "url", url: "example.com" })).toBeNull();
    expect(decodeLinkTarget({ kind: "note", target: "a]]b" })).toBeNull();
    expect(decodeLinkTarget({ kind: "note", target: "" })).toBeNull();
    expect(decodeLinkTarget({ kind: "note", target: 3 })).toBeNull();
    expect(decodeLinkTarget(null)).toBeNull();
  });
});

describe("the sheet's rows", () => {
  test("nothing typed: no rows, and the field's hint does the talking", () => {
    expect(linkRows("", PATHS, null)).toEqual([]);
    expect(linkRows("   ", PATHS, null)).toEqual([]);
  });

  test("an address: one row, 'Link to this web page'", () => {
    const rows = linkRows("example.com/launch", PATHS, null);
    expect(rows.map((row) => [row.title, row.detail, row.icon])).toEqual([
      ["Link to this web page", "https://example.com/launch", "globe"],
    ]);
    expect(rows[0].link).toEqual({ kind: "url", url: "https://example.com/launch" });
  });

  test("a name: the matching notes, title and folder, then a link to the words themselves", () => {
    const rows = linkRows("launch", PATHS, "2-areas/weekly-review.md");
    expect(rows.map((row) => [row.title, row.detail])).toEqual([
      // `noteChoices`' own order: the name-starts band, by path.
      ["launch-plan", "1-projects"],
      ["launch-checklist", "2-areas/ops"],
      ["relaunch", "3-resources"],
      ['Link to "launch"', "A note that may not exist yet"],
    ]);
    expect(rows[0].link).toEqual({ kind: "note", target: "1-projects/launch-plan" });
    expect(rows[3].link).toEqual({ kind: "note", target: "launch" });
  });

  test("a note at the top level says so rather than showing an empty folder", () => {
    expect(linkRows("overview", PATHS, null)[0]).toMatchObject({ title: "overview", detail: "Top level" });
  });

  test("the note being edited is never offered", () => {
    const rows = linkRows("launch-plan", PATHS, "1-projects/launch-plan.md");
    expect(rows.some((row) => row.link.kind === "note" && row.link.target === "1-projects/launch-plan")).toBe(false);
  });

  test("a name a note already answers to is still offered, labelled as linking by name", () => {
    const rows = linkRows("overview", PATHS, null);
    expect(rows[rows.length - 1]).toMatchObject({ title: 'Link to "overview"', detail: "Links by name" });
  });

  test("no more notes than fit above a keyboard", () => {
    const many = Array.from({ length: 20 }, (_, i) => `notes/launch-${i}.md`);
    const rows = linkRows("launch", many, null);
    expect(rows.filter((row) => row.icon === "file")).toHaveLength(SHEET_NOTE_ROWS);
    expect(rows[rows.length - 1].key).toBe("free");
  });
});
