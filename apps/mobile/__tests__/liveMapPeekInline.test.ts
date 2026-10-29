/**
 * THE MAP CARD'S WORDS, AS THE EDITOR DRAWS THEM.
 *
 * Dev2 (2026-10-28), with a screenshot of the card: "in map notes preview,
 * links don't show up properly [[]]". The card drew each block's source as
 * typed, so `**Status:**` kept its asterisks, `[[V2L Org Chart]]` its
 * brackets, and `---` its dashes. These are the pure parts: a line cut into
 * styled runs and links, the blocks a rule and a quote make, and which note
 * a wiki link on the map names. Fake names only.
 */
import { describe, expect, test } from "@jest/globals";
import { peekRuns } from "../features/console/map/live/peek/peekInline";
import { peekBlocks } from "../features/console/map/live/peek/peekModel";
import { nameBook } from "../features/console/map/live/feed";
import { graph } from "./liveMapFixture";

describe("a line, as runs", () => {
  test("the screenshot's line: bold without asterisks, links without brackets", () => {
    expect(peekRuns("**Status:** draft. See [[#Adoption]].")).toEqual([
      { text: "Status:", style: "strong" },
      { text: " draft. See ", style: "plain" },
      { text: "#Adoption", style: "plain", link: { kind: "note", target: "#Adoption" } },
      { text: ".", style: "plain" },
    ]);
    const also = peekRuns("See also: [[Org Chart]] · [[Restructure]]");
    expect(also.map((r) => r.text).join("")).toBe("See also: Org Chart · Restructure");
    expect(also.filter((r) => r.link).map((r) => r.link)).toEqual([
      { kind: "note", target: "Org Chart" },
      { kind: "note", target: "Restructure" },
    ]);
  });

  test("an alias is what is drawn, and a path shows only the note's name", () => {
    expect(peekRuns("[[1-projects/launch/plan|the plan]] and [[2-areas/finance.md#Q4]]")).toEqual([
      { text: "the plan", style: "plain", link: { kind: "note", target: "1-projects/launch/plan" } },
      { text: " and ", style: "plain" },
      { text: "finance#Q4", style: "plain", link: { kind: "note", target: "2-areas/finance.md#Q4" } },
    ]);
  });

  test("a link inside bold is still a link, and still bold", () => {
    expect(peekRuns("**read [[Pricing]] first**")).toEqual([
      { text: "read ", style: "strong" },
      { text: "Pricing", style: "strong", link: { kind: "note", target: "Pricing" } },
      { text: " first", style: "strong" },
    ]);
  });

  test("inside a code span nothing is markup, a wiki link included", () => {
    expect(peekRuns("type `[[name]]` or `**x**`")).toEqual([
      { text: "type ", style: "plain" },
      { text: "[[name]]", style: "code" },
      { text: " or ", style: "plain" },
      { text: "**x**", style: "code" },
    ]);
  });

  test("italic, struck, highlighted and web links", () => {
    expect(peekRuns("*soft* ~~gone~~ ==key== [site](https://example.com)")).toEqual([
      { text: "soft", style: "em" },
      { text: " ", style: "plain" },
      { text: "gone", style: "strike" },
      { text: " ", style: "plain" },
      { text: "key", style: "mark" },
      { text: " ", style: "plain" },
      { text: "site", style: "plain", link: { kind: "url", href: "https://example.com" } },
    ]);
  });

  test("an unsafe web link is words, an embed is its name, and stand-in characters in a note forge nothing", () => {
    expect(peekRuns("[x](javascript:alert(1))")).toEqual([{ text: "x", style: "plain" }]);
    expect(peekRuns("![[diagram.png]]")).toEqual([{ text: "diagram.png", style: "plain" }]);
    const forged = peekRuns("a 0 b [[Real]]");
    expect(forged.filter((r) => r.link)).toEqual([{ text: "Real", style: "plain", link: { kind: "note", target: "Real" } }]);
    expect(forged.map((r) => r.text).join("")).toBe("a 0 b Real");
  });
});

describe("blocks", () => {
  test("a rule is a rule and a quote is a quote, not dashes and a bracket", () => {
    expect(peekBlocks("Above.\n\n---\n\n> Quoted **words**.\n\n- item")).toEqual([
      { kind: "paragraph", text: "Above." },
      { kind: "rule", text: "" },
      { kind: "quote", text: "Quoted **words**." },
      { kind: "item", text: "item" },
    ]);
  });
});

describe("which note a link on the map names", () => {
  const ws = graph("ws-p", "Personal", ["1-projects/v2l/org-chart.md", "1-projects/v2l/statutes.md", "2-areas/finance.md", "3-resources/a/dup.md", "3-resources/b/dup.md"]);
  ws.nodes[0]!.title = "Org Chart";
  const book = nameBook([ws]);
  const from = "1-projects/v2l/statutes.md";

  test("by name, loosely, by path, and a heading of the same note", () => {
    expect(book.link("ws-p", from, "org-chart")).toBe("1-projects/v2l/org-chart.md");
    expect(book.link("ws-p", from, "Org Chart")).toBe("1-projects/v2l/org-chart.md");
    expect(book.link("ws-p", from, "2-areas/finance#Q4")).toBe("2-areas/finance.md");
    expect(book.link("ws-p", from, "#Adoption")).toBe(from);
  });

  test("nothing for a note the map does not hold, or another workspace's", () => {
    expect(book.link("ws-p", from, "Nowhere")).toBeNull();
    expect(book.link("ws-p", from, "9-secret/plans")).toBeNull();
    expect(book.link("ws-other", from, "org-chart")).toBeNull();
  });
});
