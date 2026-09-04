import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@jest/globals";

import { FONT_STYLESHEET_HREF, FONT_STYLESHEET_ID } from "../features/design/fonts.web";
import { darkColors, lightColors } from "../features/design/tokens";

/**
 * THE SHELL THAT SHIPS, AND THE FACT THAT IT IS THE ONE BEING CHECKED.
 *
 * This suite used to read `app/+html.tsx` and assert its ground colours
 * against the palette. Every assertion passed. **The file was never served.**
 *
 * `+html.tsx` belongs to Expo Router's static rendering — it is rendered per
 * route when `expo.web.output` is `"static"` or `"server"`. This app's
 * `output` is unset, which means `"single"`, and the single-page export builds
 * its document from `public/index.html` when there is one and from Expo's
 * stock template when there is not. `@expo/cli`'s `createTemplateHtmlAsync`
 * never looks at `+html.tsx`.
 *
 * So the shipped shell was the stock template: no ground on `html`/`body`, no
 * fonts, no referrer policy. Measured against a real `expo export -p web` on a
 * 20 Mbps link, `/console/@name` was **pure white for 1.9 seconds** and then
 * repainted `#050506` when the app mounted. A white-to-black flash on every
 * refresh, and this suite was green throughout.
 *
 * Hence the last test here, which is the one that matters: a shell in a file
 * the bundler ignores is a shell nobody sees, so `+html.tsx` may not exist
 * while the output is single. Deleting that test and restoring the old file
 * puts the flash straight back.
 */

const mobileRoot = join(__dirname, "..");
const shell = readFileSync(join(mobileRoot, "public", "index.html"), "utf8");

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

  test("the type is linked from the head, not only injected at runtime", () => {
    /*
      `fonts.web.ts` appends the same stylesheet from app code, which is a
      belt to this brace and runs 3.3 MB of bundle later — far too late to
      stop a flash of fallback type. Pinning the two together means a change
      of family cannot silently apply to one of them.
    */
    expect(shell).toContain(`href="${FONT_STYLESHEET_HREF}"`);
  });

  test("and it carries the id the runtime injection looks for", () => {
    // Without it `ensureFontsLoaded` cannot see the link already in the head
    // and appends a second one on every web load — same href, so nothing
    // breaks and nothing tells you either.
    expect(shell).toContain(`id="${FONT_STYLESHEET_ID}"`);
  });

  test("no URL of ours is handed to Google Fonts", () => {
    // `/invite/<token>?code=…` is the highest-value URL in the product and
    // this document makes cross-origin requests. Today's browser default
    // already sends only the origin; this is one default away from a leak.
    expect(shell).toContain('<meta name="referrer" content="no-referrer" />');
  });
});

describe("it is still a template Expo can fill in", () => {
  /*
    The single-page export treats this file as a template rather than a
    finished document: it substitutes the two placeholders, appends the
    bundle's <script> to <body>, and inserts stylesheet links and the favicon
    before </head>. Losing any of these is a blank page or a missing tag, and
    the failure is at build time on a file nobody re-reads.
  */
  test.each(["%LANG_ISO_CODE%", "%WEB_TITLE%", "</head>", '<div id="root">'])(
    "%s appears exactly once",
    (needle) => {
      /*
        Once, not merely present. Every one of these is the target of a plain
        `String.replace`, which takes the **first** match — so a second copy of
        one anywhere in the file, a comment included, silently steals the
        substitution. Writing this shell's own explanation into it did exactly
        that: the favicon link Expo inserts before the closing head tag landed
        inside the paragraph describing where Expo inserts it, and the export
        shipped with no favicon and a head that had never been touched.
      */
      expect(shell.split(needle)).toHaveLength(2);
    },
  );

  test("react-native-web's reset is present, since nothing else contributes it", () => {
    // `ScrollViewStyleReset` is a static-rendering component and cannot run
    // here; this is the same block, copied from Expo's stock template.
    expect(shell).toContain('<style id="expo-reset">');
    expect(shell).toContain("overflow: hidden;");
  });
});

describe("the shell being checked is the shell being served", () => {
  test("the export is single-page, so `public/index.html` is the document", () => {
    // If this ever becomes "static" or "server", `+html.tsx` is rendered
    // again and this whole suite is pointed at the wrong file — so the
    // assumption is asserted rather than assumed.
    const config = require(join(mobileRoot, "app.config.js"));
    const resolved = typeof config === "function" ? config({ config: {} }) : config;
    const expo = resolved.expo ?? resolved;
    expect(expo.web?.output ?? "single").toBe("single");
  });

  test("`app/+html.tsx` does not exist, because nothing would render it", () => {
    /*
      The bug this suite failed to catch, as a guard. A shell living there is
      dead code that reads like the served document — the palette assertions
      above passed against it for the whole time the site was flashing white.
    */
    expect(existsSync(join(mobileRoot, "app", "+html.tsx"))).toBe(false);
  });
});
