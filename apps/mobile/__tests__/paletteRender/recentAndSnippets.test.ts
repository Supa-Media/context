/**
 * @jest-environment jsdom
 */

/**
 * The phone search of the 2026-09-27 redesign: an untyped search lists the
 * notes somebody was just in, a row's dim line names its folder and the words
 * that matched, and a note both halves found keeps both.
 *
 * See `fixtures.ts` in this folder for the mounting harness.
 */

import { describe, expect, test } from "@jest/globals";
import { PHONE, type PaletteItem, mount } from "./fixtures";

const RECENT: PaletteItem[] = [
  { id: "website/03-devlog.md", label: "devlog", detail: "website", kind: "note" },
  { id: "website/02-pricing.md", label: "Pricing", detail: "website", kind: "note" },
];

describe("an untyped search", () => {
  test("lists the recent notes under Recent, instead of everything loaded", () => {
    const palette = mount(PHONE, { recent: RECENT });
    const rows = palette.rowLabels();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("devlog");
    expect(rows[1]).toContain("Pricing");
    expect(palette.find("palette-heading")?.textContent).toBe("Recent");
  });

  test("typing leaves the recents for the ranked list", () => {
    const palette = mount(PHONE, { recent: RECENT });
    palette.type("today");
    expect(palette.rowLabels()).toHaveLength(1);
    expect(palette.rowLabels()[0]).toContain("today.md");
  });

  test("with no recents yet it lists what is loaded, as before", () => {
    const palette = mount(PHONE, { recent: [] });
    expect(palette.rowLabels().length).toBeGreaterThan(2);
  });
});

describe("the dim line", () => {
  test("names the folder, then the words in the note that matched", () => {
    const palette = mount(PHONE, {
      search: {
        onQuery: () => {},
        state: "ready",
        items: [
          {
            id: "website/03-devlog.md",
            label: "devlog",
            detail: "website",
            snippet: "…onboarding, private sharing…",
            kind: "note",
          },
        ],
      },
    });
    palette.type("private");
    expect(palette.find("palette-detail")?.textContent).toBe("website · …onboarding, private sharing…");
  });

  test("a note the name filter and the body search both found is one row, with the snippet", () => {
    const palette = mount(PHONE, {
      search: {
        onQuery: () => {},
        state: "ready",
        items: [{ id: "0-inbox/today.md", label: "today", snippet: "today, the standup", kind: "note" }],
      },
    });
    palette.type("today");
    const rows = palette.rowLabels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("0-inbox · today, the standup");
  });
});
