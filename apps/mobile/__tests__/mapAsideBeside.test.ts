/**
 * THE MAP KEEPS ITS RIGHT PANEL BESIDE IT (Dev2, 2026-11-05: "there is no way
 * to interact with the side panel as i'm moving through the map").
 *
 * At medium the right panel comes in over the note behind a scrim, which is
 * right for a note and wrong for the live map: the panel holds the map's
 * Activity and the clicked note, and is used while the map moves. A page that
 * asks (`asideBeside`) gets it as a column at medium as well.
 *
 * Sabotage record: `regionsFor` ignoring `asideBeside` → "the map's panel is
 * a column at medium" fails.
 */
import { describe, expect, test } from "@jest/globals";
import { initialFrame, regionsFor, type FrameState } from "../features/app/frame";

const open: FrameState = { ...initialFrame, asideOpen: true };

describe("the right panel beside the map", () => {
  test("the map's panel is a column at medium, with no scrim over the map", () => {
    const regions = regionsFor("medium", open, { hasExplorer: true, asideBeside: true });
    expect(regions.aside).toBe("column");
    expect(regions.scrim).toBe(false);
    expect(regions.explorer).toBe("column");
  });

  test("a note's panel at medium is still over it, behind a scrim", () => {
    expect(regionsFor("medium", open, { hasExplorer: true }).aside).toBe("overlay");
  });

  test("asking changes nothing on a phone, at wide, or with the panel shut", () => {
    expect(regionsFor("compact", open, { asideBeside: true }).aside).toBe("hidden");
    expect(regionsFor("wide", open, { asideBeside: true }).aside).toBe("column");
    expect(regionsFor("medium", initialFrame, { asideBeside: true }).aside).toBe("hidden");
  });
});
