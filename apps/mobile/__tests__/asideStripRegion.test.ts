/**
 * Shut is the strip (Dev2, 2026-11-19, on the top-right corner: the panel
 * button went, so the rail is always there). Where a console supplies a right
 * panel, a pointer layout keeps a folded-width column for it even when shut;
 * a phone keeps none.
 */
import { describe, expect, test } from "@jest/globals";
import { initialFrame, regionsFor } from "../features/app/frame";
import { asideUnfolded } from "../features/app/appFrame/useFrameController";

describe("the right panel's strip", () => {
  test("where a panel is supplied, shut is its strip: a column at every pointer density", () => {
    for (const density of ["medium", "wide"] as const) {
      expect(regionsFor(density, initialFrame, { hasAside: true }).aside).toBe("column");
      // Folded is the strip too, never an overlay over the note.
      expect(regionsFor(density, { ...initialFrame, asideOpen: true, asideFolded: true }, { hasAside: true }).aside).toBe("column");
    }
    // A phone still has none.
    expect(regionsFor("compact", initialFrame, { hasAside: true }).aside).toBe("hidden");
  });

  test("with no panel supplied, shut is nothing on the screen", () => {
    expect(regionsFor("wide", initialFrame).aside).toBe("hidden");
  });

  test("only open and not folded is the whole panel", () => {
    expect(asideUnfolded({ asideOpen: true, asideFolded: false })).toBe(true);
    expect(asideUnfolded({ asideOpen: true, asideFolded: true })).toBe(false);
    expect(asideUnfolded({ asideOpen: false, asideFolded: false })).toBe(false);
  });
});
