import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The landing hero's actions must stay on one shared left edge.
 *
 * ## The bug this file was born from, which is still worth knowing
 *
 * `Button`'s base style carries `alignSelf: "flex-start"`, so a button never
 * stretches to fill its container. In a **row** that governs the vertical axis
 * and is invisible. The hero's actions used to be a centred **column**, where
 * the same property means "hug the left edge" — and a child's `alignSelf`
 * beats the parent's `alignItems: "center"`.
 *
 * The column was only as wide as its widest child, so the wide CTA looked
 * correct and the narrower "Read the architecture" link sat **44px left of
 * centre**. At every screen size, not only on a phone: it survived desktop
 * review and was caught on somebody's actual phone.
 *
 * ## What changed, and why this file did not simply go
 *
 * The hero is ranged left now rather than centred, and the actions are a row
 * rather than a column — the composition the design canvas draws. That kills
 * the original bug at the root: in a row, `alignSelf` governs the vertical
 * axis and cannot push a button off a horizontal centre that no longer exists.
 *
 * Deleting the file would have been the easy move and the wrong one. The
 * hazard it documents is a property of `Button` that is still there, and the
 * thing worth pinning is no longer "these are centred" but "these share one
 * edge, explicitly, rather than by whatever a default happens to do". If the
 * actions ever go back to being a column, the row assertion below fails and
 * this comment is waiting.
 *
 * ## What this test is, and what it is not
 *
 * It reads the source. It is **not** a layout test and cannot measure
 * anything: this suite runs in plain node with no renderer, and
 * `react-native` is outside the jest transform (see `jest.config.js`), so
 * `StyleSheet` cannot even be imported. A jsdom render was tried first and
 * crashed on exactly that. The real verification is a browser — the original
 * fix was measured in a production `expo export` at 390px and 1440px, and the
 * left-ranged version was screenshotted the same way.
 */

const LANDING = readFileSync(join(__dirname, "../features/landing/Landing.tsx"), "utf8");

describe("the landing hero ranges its actions left", () => {
  test("the buttons sit in a row, which is what disarms the alignSelf hazard", () => {
    // `actionRow`, not `actions`: the buttons are a row nested inside the
    // column, so the store caption below them stays a caption instead of
    // lining up as a third action. That distinction is the whole reason the
    // two styles exist, so the assertion names the one that holds the buttons.
    const start = LANDING.indexOf("  actionRow: {");
    expect(start).toBeGreaterThan(-1);
    const block = LANDING.slice(start, LANDING.indexOf("},", start));
    expect(block).toMatch(/flexDirection:\s*"row"/);
  });

  test("the caption is outside that row", () => {
    /*
      `ALSO_ON_PHONE`, not the sentence.

      This searched for the literal `"Also on your phone"` and stopped finding
      it the moment the page's words moved into `copy.ts` — where
      `landingCopy.test.ts` can hold them to the vocabulary rules, which is
      worth more than a string this file can grep for. A source-reading test
      that names a *constant* survives its copy being edited; one that names
      the copy is a test about the wording wearing a layout assertion's name.
    */
    const rowStart = LANDING.indexOf("<View style={styles.actionRow}>");
    const rowEnd = LANDING.indexOf("</View>", rowStart);
    expect(rowStart).toBeGreaterThan(-1);
    expect(LANDING.indexOf("{ALSO_ON_PHONE}")).toBeGreaterThan(rowEnd);
  });

  test("every action still carries an explicit alignment", () => {
    // The bug was one Button in this column without the override, so the count
    // is what matters — not which value it holds. Nothing here may rely on
    // `Button`'s default.
    const start = LANDING.indexOf("<View style={styles.actions}>");
    expect(start).toBeGreaterThan(-1);
    /*
      The block's far edge is found by the identifier that renders that line,
      not by the line itself. It used to be the sentence "Also on your phone",
      and when the page's words were lifted into `features/landing/copy.ts` the
      `indexOf` went to −1 and this slice collapsed to nothing — a test that
      counted zero Buttons and said so. Copy is expected to change; the name a
      component imports is refactored with it.
    */
    const end = LANDING.indexOf("</View>", LANDING.indexOf("ALSO_ON_PHONE", start));
    const block = LANDING.slice(start, end);
    const buttons = block.match(/<Button\b/g) ?? [];
    const aligned = block.match(/style=\{styles\.actionItem\}/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(aligned).toHaveLength(buttons.length);
  });

  test("the premise still holds: Button defaults to flex-start", () => {
    // If this default ever goes away, the override above stops being
    // load-bearing and this file should be deleted rather than left implying a
    // protection it no longer provides.
    const button = readFileSync(join(__dirname, "../features/design/components/Button.tsx"), "utf8");
    expect(button).toMatch(/alignSelf:\s*"flex-start"/);
  });
});
