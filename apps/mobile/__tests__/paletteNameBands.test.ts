/**
 * ⌘K finds a note by its name's words, the way the `[[` link suggestions do.
 *
 * Before, ⌘K matched only letters in order, the space included, so typing
 * "llc formation" never found `llc-formation`: the name has a hyphen where the
 * query has a space. `rank` now puts every item in the bands `noteChoices.ts`
 * defines first, and letters in order only order the items inside a band.
 *
 * Fixtures are obviously fake; this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import { noteItem, rank, type PaletteItem } from "../features/console/files/palette";

const ids = (query: string, items: readonly PaletteItem[]) => rank(query, items).map((match) => match.item.id);

describe("⌘K ranks names by their words", () => {
  const items = [
    noteItem("projects/llc-formation/task-ein-and-relay.md"),
    noteItem("projects/llc-formation.md"),
    noteItem("areas/lilac-cleanup-for-mation.md"),
    noteItem("resources/books/deuteronomy-32.md"),
  ];

  test("words typed with a space find a hyphenated name", () => {
    expect(ids("llc formation", items)[0]).toBe("projects/llc-formation.md");
  });

  test("the words can come in any order", () => {
    expect(ids("formation llc", items)[0]).toBe("projects/llc-formation.md");
  });

  test("a note inside the named folder still comes up, after the note itself", () => {
    const found = ids("llc formation", items);
    expect(found).toContain("projects/llc-formation/task-ein-and-relay.md");
    expect(found.indexOf("projects/llc-formation.md")).toBeLessThan(
      found.indexOf("projects/llc-formation/task-ein-and-relay.md"),
    );
  });

  test("the start of each word is enough", () => {
    expect(ids("deut 32", items)[0]).toBe("resources/books/deuteronomy-32.md");
  });

  test("a name the words start outranks letters that merely appear in order", () => {
    // "lilac-cleanup-for-mation" holds l…l…c…f…o…r…m…a…t…i…o…n in order, which
    // letters in order alone would rank; the words do not start its words.
    const found = ids("llc formation", items);
    const lilac = found.indexOf("areas/lilac-cleanup-for-mation.md");
    if (lilac >= 0) expect(lilac).toBeGreaterThan(found.indexOf("projects/llc-formation.md"));
  });

  test("the typed words are lit in the name", () => {
    const [first] = rank("llc formation", items);
    const lit = first.ranges.map(([start, end]) => first.item.label.slice(start, end).toLowerCase());
    expect(lit).toEqual(["llc", "formation"]);
  });

  test("nothing typed keeps the input order", () => {
    expect(ids("", items)).toEqual(items.map((item) => item.id));
  });
});
