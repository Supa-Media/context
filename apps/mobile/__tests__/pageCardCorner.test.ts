/**
 * The note card (Dev2, 2026-11-20, the in-app Tex mock, "take inspiration from grokbot"): at a pointer density the tabs
 * and the page are one card on the chrome, rounded at its top corners and inset from the tree and the right panel. Its
 * top is in the bar (`topCard`) and its body is the page (`editorCard`), so the two must agree on the insets or the card
 * draws a step where they meet.
 */
import { describe, expect, it } from "@jest/globals";
import { lightColors, lightShadows, space } from "../features/design/tokens";
import { makeStyles } from "../features/app/appFrame/styles";

const styles = makeStyles(lightColors, lightShadows);

describe("the note card", () => {
  it("rounds its top corners, in the page's own surface", () => {
    expect(styles.topCard.borderTopLeftRadius).toBeGreaterThan(0);
    expect(styles.topCard.borderTopRightRadius).toBeGreaterThan(0);
    expect(styles.topCard.backgroundColor).toBe(lightColors.pageSurface);
  });

  it("has the same left and right insets at its top and in its body", () => {
    expect(styles.topCard.marginLeft).toBe(styles.editorCard.marginLeft);
    // The bar's own trailing padding is taken back at the top, so both edges land at the same place.
    expect(Number(styles.topCard.marginRight) + space.x3).toBe(styles.editorCard.marginRight);
  });

  it("sits on the chrome, not on the page's own colour, so its edges can be seen", () => {
    expect(styles.body.backgroundColor).toBe(lightColors.chromeSurface);
    expect(lightColors.chromeSurface).not.toBe(lightColors.pageSurface);
  });
});
