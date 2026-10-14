/**
 * @jest-environment jsdom
 */

/**
 * ⌘K's `in:` filter, mounted for real (Dev2, 2026-10-14): typing `in:` lists
 * the workspaces under a heading, Enter or a press picks one into a chip and
 * leaves the words, Backspace in an empty field takes the chip off, and an
 * untyped palette lists the filter after Recent so Enter still opens a note.
 * The rules are `searchFilters.ts`'s, pinned in `searchFilters.test.ts`; these
 * are about the palette drawing and walking them.
 *
 * Sabotage: dropping the `typing` branch from `matches` reddens the listing,
 * the Enter pick and the filter-row pick (checked 2026-10-14).
 */

import { describe, expect, jest, test } from "@jest/globals";
import { DESKTOP, PHONE, mount } from "./fixtures";
import { workspaceFilters } from "../../features/console/layout/searchFilters";

const contexts = [
  { slug: "acme", displayName: "Acme Ltd" },
  { slug: "jo", displayName: "Jo Example" },
];

function withFilters(narrowed: string | null = null) {
  const narrow = jest.fn<(slug: string | null) => void>();
  return { narrow, filters: workspaceFilters(contexts, narrowed, narrow) };
}

const input = () => document.querySelector<HTMLInputElement>('[data-testid="palette-input"]')!;

describe("typing in:", () => {
  test("lists the workspaces under their own heading, and nothing else", () => {
    const { filters } = withFilters();
    const palette = mount(DESKTOP, { filters });
    palette.type("in:");
    expect(palette.find("palette-filters-heading")?.textContent).toBe("Search in");
    expect(palette.rowLabels()).toEqual([
      "@acmeAcme Ltd",
      "@joJo Example",
    ]);
    palette.type("in:j");
    expect(palette.rowLabels()).toEqual(["@joJo Example"]);
  });

  test("says so when no workspace has that name, rather than 'no notes'", () => {
    const { filters } = withFilters();
    const palette = mount(DESKTOP, { filters });
    palette.type("in:zzz");
    expect(palette.find("palette-empty")?.textContent).toContain("No workspace you can search is called “zzz”");
  });

  test("Enter picks into the field: narrowed, the in: gone, the words kept, nothing opened", () => {
    const { filters, narrow } = withFilters();
    const palette = mount(DESKTOP, { filters });
    palette.type("rent in:ac");
    palette.press("Enter");
    expect(narrow).toHaveBeenCalledWith("acme");
    expect(input().value).toBe("rent ");
    expect(palette.chosen).toEqual([]);
  });

  test("a whole in:name and a space becomes the filter as it is typed", () => {
    const { filters, narrow } = withFilters();
    const palette = mount(DESKTOP, { filters });
    palette.type("in:jo ");
    expect(narrow).toHaveBeenCalledWith("jo");
    expect(input().value).toBe("");
  });
});

describe("the chip", () => {
  test("is drawn in the field, and Backspace in an empty field takes it off", () => {
    const { filters, narrow } = withFilters("acme");
    const palette = mount(DESKTOP, { filters });
    expect(palette.find("palette-filter-in")?.textContent).toBe("in: @acme");
    palette.press("Backspace");
    expect(narrow).toHaveBeenCalledWith(null);
  });

  test("its × takes it off too, on a phone as on a desk", () => {
    const { filters, narrow } = withFilters("jo");
    const palette = mount(PHONE, { filters });
    palette.click("palette-filter-in");
    expect(narrow).toHaveBeenCalledWith(null);
  });
});

describe("an untyped palette", () => {
  test("lists the filter after Recent, so Enter still opens the last note", () => {
    const { filters } = withFilters();
    const recent = [{ id: "0-inbox/today.md", label: "today.md", detail: "0-inbox", kind: "note" as const }];
    const palette = mount(DESKTOP, { filters, recent });
    const rows = palette.rowLabels();
    expect(rows[0]).toContain("today.md");
    expect(rows[1]).toContain("In a specific workspace");
    expect(palette.find("palette-filters-heading")?.textContent).toBe("Filters");
    palette.press("Enter");
    expect(palette.chosen.map((item) => item.id)).toEqual(["0-inbox/today.md"]);
  });

  test("picking the filter row starts an in: and keeps the caret", () => {
    const { filters } = withFilters();
    const palette = mount(DESKTOP, { filters });
    palette.click(`palette-row-${palette.rowLabels().findIndex((row) => row.includes("In a specific workspace"))}`);
    expect(input().value).toBe("in:");
    expect(palette.find("palette-filters-heading")?.textContent).toBe("Search in");
  });
});

describe("pointer rows", () => {
  test("a note row draws no grey box beside it (Dev2, 2026-10-14)", () => {
    const palette = mount(DESKTOP);
    for (const row of palette.all('[data-testid^="palette-row-"]')) {
      expect([...row.querySelectorAll("*")].some((node) => /^[▢▸⌘]$/.test(node.textContent ?? ""))).toBe(false);
    }
  });
});
