import { describe, expect, test } from "@jest/globals";

import { makeStyles as paletteStyles } from "../features/design/components/PaletteStyles";
import { darkColors } from "../features/design/tokens";

/**
 * Search fields draw their own frame, so the browser's focus ring must not
 * draw a second one inside it. The owner called the blue box drawn in the
 * quick-search panel "super ugly" (2026-10-07), and it was still there on
 * 2026-10-14 ("not needed ever"): `outlineWidth: 0` stops Chrome's ring but
 * not Safari's, which draws an `auto` outline at its own width. Only
 * `outlineStyle: "none"` stops both. The file tree's own filter field went
 * when the two searches became one (2026-10-17).
 */
describe("search fields carry no browser focus ring", () => {
  test("quick search, on a desk and on a phone", () => {
    const styles = paletteStyles(darkColors);
    expect(styles.input.outlineWidth).toBe(0);
    expect((styles.input as { outlineStyle?: string }).outlineStyle).toBe("none");
  });
});
