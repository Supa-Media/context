import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@jest/globals";

import { darkColors, lightColors } from "../features/design/tokens";

/**
 * The web shell's ground, against the palettes.
 *
 * `app/+html.tsx` is rendered once at build time and paints `html`/`body`
 * before any of the app's JavaScript runs, so its two ground colours are
 * written out as literals rather than imported — importing `tokens.ts` would
 * pull `react-native` into the document shell's module graph for two hex
 * values.
 *
 * Two literals claiming to equal two tokens is exactly the shape that goes
 * quietly wrong: change `ground` in the palette and the app repaints while the
 * page behind it keeps the old colour, which shows up as a mismatched band
 * during load and behind rubber-band scroll — on a surface nobody screenshots.
 * So the claim is checked rather than commented.
 *
 * Read as text on purpose. The alternative is exporting the CSS string and
 * asserting on it, which would prove the export matches the palette while the
 * file's own `<style>` said something else.
 */
const shell = readFileSync(join(__dirname, "..", "app", "+html.tsx"), "utf8");

describe("the web shell's ground", () => {
  test("the light rule paints the light palette's ground", () => {
    expect(shell).toContain(`background-color: ${lightColors.ground};`);
  });

  test("the dark rule paints the dark palette's ground", () => {
    expect(shell).toContain(`background-color: ${darkColors.ground};`);
  });

  test("light is the default and dark is the media query", () => {
    // `prefers-color-scheme` reports "light" for no-preference, and
    // `resolveScheme` treats only an explicit "light" as light — so the shell
    // has to default to light and override in the dark query, not the reverse.
    // A shell that guessed the other way flashes black at every light visitor.
    const darkAt = shell.indexOf("@media (prefers-color-scheme: dark)");
    const lightGroundAt = shell.indexOf(`background-color: ${lightColors.ground};`);
    const darkGroundAt = shell.indexOf(`background-color: ${darkColors.ground};`);
    expect(darkAt).toBeGreaterThan(-1);
    expect(lightGroundAt).toBeLessThan(darkAt);
    expect(darkGroundAt).toBeGreaterThan(darkAt);
  });

  test("both appearances are declared to the browser", () => {
    expect(shell).toContain('<meta name="color-scheme" content="light dark" />');
    expect(shell).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${darkColors.ground}" />`,
    );
    expect(shell).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${lightColors.ground}" />`,
    );
  });

  test("selection ink is the palette's text in each appearance", () => {
    expect(shell).toContain(`color: ${lightColors.text}; }`);
    expect(shell).toContain(`color: ${darkColors.text}; }`);
  });
});
