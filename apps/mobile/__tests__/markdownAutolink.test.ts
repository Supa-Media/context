/**
 * Plain URLs and domains in a note are links on the page, as the editor draws
 * them — a public site whose links are grey text is the complaint this exists
 * to answer. The guards matter as much as the matches: a file name, an email
 * address and a version number are not sites.
 */
import { describe, expect, test } from "@jest/globals";
import { parseInline } from "../features/share/markdown";

function links(source: string) {
  return parseInline(source)
    .filter((part) => part.kind === "link")
    .map((part) => (part.kind === "link" ? [part.text, part.href] : []));
}

describe("plain-text links", () => {
  test("a bare domain links over https", () => {
    expect(links("see supa.media for more")).toEqual([["supa.media", "https://supa.media"]]);
  });

  test("a full URL links as written, without the sentence's full stop", () => {
    expect(links("Go to https://context.lc/pricing.")).toEqual([
      ["https://context.lc/pricing", "https://context.lc/pricing"],
    ]);
  });

  test("a www address gains a scheme", () => {
    expect(links("(www.togather.nyc)")).toEqual([["www.togather.nyc", "https://www.togather.nyc"]]);
  });

  test("a file name, an email address and a version are not links", () => {
    expect(links("edit notes.md, mail me@site.com, ship v1.2.3")).toEqual([]);
  });

  test("a written link is still one link, not two", () => {
    expect(links("[my site](https://seyi.co)")).toEqual([["my site", "https://seyi.co"]]);
  });

  test("a written link to a bare domain opens that site, as editors write them", () => {
    expect(links("[supa.media](supa.media) and [notes](notes.md)")).toEqual([
      ["supa.media", "https://supa.media"],
    ]);
  });

  test("text that only looks like a scheme is not linked", () => {
    expect(links("javascript:alert(1) and https://")).toEqual([]);
  });
});
