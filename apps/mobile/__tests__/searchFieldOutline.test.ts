import { describe, expect, test } from "@jest/globals";

import { makeStyles as paletteStyles } from "../features/design/components/PaletteStyles";
import { makeStyles as explorerStyles } from "../features/console/files/explorer/styles";
import { darkColors, darkShadows } from "../features/design/tokens";

/**
 * Search fields draw their own frame, so the browser's focus ring must not
 * draw a second one inside it. The owner called the blue box Chrome drew in
 * the quick-search panel "super ugly" (2026-10-07); RN-Web turns
 * `outlineWidth: 0` into the inline style that stops it.
 */
describe("search fields carry no browser focus ring", () => {
  test("quick search, on a desk and on a phone", () => {
    const styles = paletteStyles(darkColors);
    expect(styles.input.outlineWidth).toBe(0);
  });

  test("the file tree's filter field", () => {
    const styles = explorerStyles(darkColors, darkShadows);
    expect(styles.filter.outlineWidth).toBe(0);
  });
});
