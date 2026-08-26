import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The landing hero's actions must stay centred.
 *
 * `Button`'s base style carries `alignSelf: "flex-start"`, so a button never
 * stretches to fill its container. In a **row** that governs the vertical axis
 * and is invisible. The hero's actions are a **column**, where the same
 * property means "hug the left edge" — and a child's `alignSelf` beats the
 * parent's `alignItems: "center"`.
 *
 * The column is only as wide as its widest child, so the wide CTA looked
 * correct and the narrower "Read the architecture" link sat **44px left of
 * centre**. At every screen size, not only on a phone: it survived desktop
 * review and was caught on somebody's actual phone.
 *
 * ## What this test is, and what it is not
 *
 * It reads the source and asserts the override is present on every action. It
 * is **not** a layout test and cannot measure anything: this suite runs in
 * plain node with no renderer, and `react-native` is outside the jest
 * transform (see `jest.config.js` — every module under test here is
 * deliberately free of React Native imports), so `StyleSheet` cannot even be
 * imported. A jsdom render was tried first and crashed on exactly that.
 *
 * So the real verification was a browser: a production `expo export` measured
 * at 390px and 1440px, every element's centre offset from the page centre
 * equal to 0 — the link having been −44 before. This test exists to catch the
 * prop being deleted later, which is the regression that would otherwise be
 * invisible until someone opened the site on a phone again.
 */

const LANDING = readFileSync(join(__dirname, "../features/landing/Landing.tsx"), "utf8");

describe("the landing hero centres its actions", () => {
  test("the centring style exists and actually centres", () => {
    expect(LANDING).toMatch(/actionItem:\s*\{\s*alignSelf:\s*"center"\s*\}/);
  });

  test("every Button in the actions column carries it", () => {
    // Slice to the actions block so a `styles.actionItem` used elsewhere on the
    // page cannot make this pass. The bug was one Button in this column
    // without the override, so the count is what matters.
    const start = LANDING.indexOf("<View style={styles.actions}>");
    expect(start).toBeGreaterThan(-1);
    const end = LANDING.indexOf("</View>", LANDING.indexOf("Also on your phone", start));
    const block = LANDING.slice(start, end);

    const buttons = block.match(/<Button\b/g) ?? [];
    const centred = block.match(/style=\{styles\.actionItem\}/g) ?? [];

    expect(buttons.length).toBeGreaterThanOrEqual(2);
    expect(centred).toHaveLength(buttons.length);
  });

  test("the premise still holds: Button defaults to flex-start", () => {
    // If this default ever goes away, the overrides above stop being
    // load-bearing and this file should be deleted rather than left implying a
    // protection it no longer provides.
    const button = readFileSync(join(__dirname, "../features/design/components/Button.tsx"), "utf8");
    expect(button).toMatch(/alignSelf:\s*"flex-start"/);
  });
});
