/**
 * ⌘K's typed filters, pinned: `in:` narrows to one workspace, Slack and
 * Discord style (Dev2, 2026-10-14). It replaced "@name " in front of the
 * words, which read like a mention and did not reliably narrow.
 *
 * Fixtures are obviously-fake slugs; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import {
  absorbFilters,
  filterFragment,
  IN_FILTER_ID,
  idleFilterRows,
  pickFilter,
  workspaceSuggestions,
} from "../features/console/layout/searchFilters";

const contexts = [
  { slug: "acme", displayName: "Acme Ltd" },
  { slug: "jo", displayName: "Jo Example" },
  { slug: "bandmates", displayName: "The Band" },
];
const slugs = contexts.map((each) => each.slug);

describe("filterFragment: an in: being typed", () => {
  test("bare in: offers every workspace", () => {
    expect(filterFragment("in:")).toEqual({ partial: "", rest: "" });
  });

  test("the words before it stay the search", () => {
    expect(filterFragment("rent in:ac")).toEqual({ partial: "ac", rest: "rent" });
  });

  test("a space after the colon and an @ are both allowed, as people type them", () => {
    expect(filterFragment("in: ac")).toEqual({ partial: "ac", rest: "" });
    expect(filterFragment("in:@ac")).toEqual({ partial: "ac", rest: "" });
    expect(filterFragment("IN:Ac")).toEqual({ partial: "Ac", rest: "" });
  });

  test("a finished token, or in: inside a word, is not being typed", () => {
    expect(filterFragment("in:acme ")).toBeNull();
    expect(filterFragment("login:x")).toBeNull();
    expect(filterFragment("rent")).toBeNull();
    expect(filterFragment("")).toBeNull();
  });
});

describe("workspaceSuggestions", () => {
  test("everything for an empty fragment, as filter rows", () => {
    const rows = workspaceSuggestions("", contexts);
    expect(rows.map((row) => row.label)).toEqual(["@acme", "@jo", "@bandmates"]);
    expect(rows.every((row) => row.kind === "filter")).toBe(true);
    expect(rows[0].detail).toBe("Acme Ltd");
  });

  test("matches slug or name, starts-with first", () => {
    expect(workspaceSuggestions("ba", contexts).map((row) => row.label)).toEqual(["@bandmates"]);
    expect(workspaceSuggestions("band", contexts).map((row) => row.label)).toEqual(["@bandmates"]);
    expect(workspaceSuggestions("example", contexts).map((row) => row.label)).toEqual(["@jo"]);
    // "the band" starts with "the"; "@jo" and "@acme" only contain an "e".
    expect(workspaceSuggestions("the", contexts).map((row) => row.label)).toEqual(["@bandmates"]);
    expect(workspaceSuggestions("e", contexts).map((row) => row.label)).toEqual(["@jo", "@acme", "@bandmates"]);
  });

  test("nothing for a name nobody has", () => {
    expect(workspaceSuggestions("zzz", contexts)).toEqual([]);
  });
});

describe("pickFilter", () => {
  test("picking a workspace narrows and leaves the words", () => {
    const [acme] = workspaceSuggestions("ac", contexts);
    expect(pickFilter(acme, "rent in:ac")).toEqual({ query: "rent ", slug: "acme" });
    expect(pickFilter(acme, "in:ac")).toEqual({ query: "", slug: "acme" });
  });

  test("picking the idle row starts an in: after what is typed", () => {
    const [row] = idleFilterRows();
    expect(row.id).toBe(IN_FILTER_ID);
    expect(pickFilter(row, "")).toEqual({ query: "in:", slug: null });
    expect(pickFilter(row, "rent")).toEqual({ query: "rent in:", slug: null });
  });
});

describe("absorbFilters: a whole in:name typed by hand", () => {
  test("becomes the filter once a space follows it", () => {
    expect(absorbFilters("in:acme rent", slugs)).toEqual({ query: "rent", slug: "acme" });
    expect(absorbFilters("rent in: @ACME ", slugs)).toEqual({ query: "rent ", slug: "acme" });
    expect(absorbFilters("rent in:acme plan", slugs)).toEqual({ query: "rent plan", slug: "acme" });
  });

  test("not before the space, so typing in:ac on the way to in:acme does not jump", () => {
    expect(absorbFilters("in:acme", slugs)).toEqual({ query: "in:acme", slug: null });
  });

  test("a name nobody has is searched for as written", () => {
    expect(absorbFilters("in:nobody rent", slugs)).toEqual({ query: "in:nobody rent", slug: null });
  });

  test("the last one wins", () => {
    expect(absorbFilters("in:acme in:jo x", slugs)).toEqual({ query: "x", slug: "jo" });
  });
});
