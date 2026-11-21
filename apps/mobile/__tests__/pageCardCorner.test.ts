/**
 * The page is a card on the chrome beside the right panel (Dev2, 2026-11-20, the in-app Tex mock): its top trailing
 * corner is rounded. The note page paints its own ground, so without clipping the card drew a square corner over the
 * rounded one and the rounding never showed.
 */
import { describe, expect, it } from "@jest/globals";
import { lightColors, lightShadows } from "../features/design/tokens";
import { makeStyles } from "../features/app/appFrame/styles";

describe("the page card beside the right panel", () => {
  const styles = makeStyles(lightColors, lightShadows);

  it("rounds its top trailing corner", () => {
    expect(styles.editorBesideAside.borderTopRightRadius).toBeGreaterThan(0);
  });

  it("clips what it holds to that corner, so the note's own ground cannot square it off", () => {
    expect(styles.editorBesideAside.overflow).toBe("hidden");
  });
});

describe("what shows at the rounded corner", () => {
  const styles = makeStyles(lightColors, lightShadows);

  it("is the chrome, not the page's own colour, so the corner can be seen", () => {
    expect(styles.body.backgroundColor).toBe(lightColors.chromeSurface);
    expect(lightColors.chromeSurface).not.toBe(lightColors.pageSurface);
  });
});
