/**
 * Render `og-card.source.html` into `src/og-card.png`.
 *
 * ## Why this file exists
 *
 * The source HTML used to carry a regeneration command in its comment —
 * headless Chrome for the screenshot, ImageMagick for the downsample and the
 * palette. Neither is installed in this repository's own development
 * environment, so the one instruction for keeping the picture and its source in
 * agreement could not be run by the people most likely to need it. A command
 * nobody can execute is how a source file and the artefact beside it drift into
 * saying different things, quietly, for as long as nobody looks.
 *
 * So the pipeline is a script, in the repository, using what the repository
 * already installs: Playwright's bundled Chromium and `sharp`.
 *
 * ## What it must keep true
 *
 *  - **1200x630.** `src/preview.ts` advertises those numbers in
 *    `og:image:width` and `og:image:height`, and `preview.test.ts` reads them
 *    back out of the PNG header. A card of another size is a card every
 *    unfurler lays out wrong.
 *  - **Rendered at 2x, downsampled.** Type at 1x on a 1200px card is soft;
 *    this is the same trade the old pipeline made.
 *  - **Quantised.** The bytes ship inside the Worker bundle, so a truecolour
 *    PNG is several times the size for no visible gain on a flat design.
 *
 * ## The font comes from the repository, and is checked for
 *
 * The source used to link Google Fonts, which made the picture depend on the
 * network: behind a TLS-proxying environment the stylesheet fails with
 * `ERR_CERT_AUTHORITY_INVALID`, the page silently falls back to the system
 * sans, and the screenshot succeeds. The card was regenerated that way once —
 * right layout, wrong letterforms, no error.
 *
 * So the face is injected from `apps/convex/functions/lib/cardFont/
 * instrumentSans.ts`, the one copy of Instrument Sans this repository holds and
 * the same bytes the *generated* card is drawn with. Nothing is fetched.
 *
 * **`document.fonts.check` is not the guard**, and that is worth stating
 * because it looks like one: with zero faces loaded it answered `true` for
 * `600 72px "Instrument Sans"` — it reports whether text *can* be rendered,
 * and a fallback can. `document.fonts.size` counts faces that actually loaded,
 * so that is what is asserted.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../og-card.source.html");
const output = resolve(here, "../src/og-card.png");
const fontModule = resolve(
  here,
  "../../../apps/convex/functions/lib/cardFont/instrumentSans.ts",
);

/**
 * The embedded font, read out of its TypeScript module as text.
 *
 * A `.ts` file cannot be imported from a plain `.mjs` script without a loader,
 * and adding one to extract a string constant is more machinery than the job
 * deserves. Regexing it out is grubby and is the honest cost of there being
 * exactly one copy of these bytes in the repository rather than two — the
 * arrangement `infra/router/src/fonts/Onest.ttf` was deleted for.
 *
 * It throws rather than falling back, because the failure this whole script
 * exists to prevent is a card that renders in the wrong typeface without
 * complaining.
 */
function embeddedFontBase64() {
  const module = readFileSync(fontModule, "utf8");
  const start = module.indexOf("INSTRUMENT_SANS_600_BASE64");
  if (start === -1) throw new Error(`no font constant in ${fontModule}`);
  const chunks = [...module.slice(start).matchAll(/"([A-Za-z0-9+/=]{16,})"/g)].map(
    (m) => m[1],
  );
  if (chunks.length === 0) throw new Error(`font constant in ${fontModule} is empty`);
  return chunks.join("");
}

const WIDTH = 1200;
const HEIGHT = 630;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await page.goto(`file://${source}`, { waitUntil: "load" });

  await page.addStyleTag({
    content:
      `@font-face{font-family:"Instrument Sans";font-style:normal;` +
      `font-weight:600;src:url(data:font/ttf;base64,${embeddedFontBase64()}) format("truetype")}`,
  });
  await page.evaluate(() => document.fonts.ready);

  const faces = await page.evaluate(() => document.fonts.size);
  if (faces < 1) {
    throw new Error(
      "no font face loaded — the card would render in the system sans",
    );
  }
  const shot = await page.screenshot({ type: "png" });

  const png = await sharp(shot)
    .resize(WIDTH, HEIGHT, { fit: "fill", kernel: "lanczos3" })
    .png({ palette: true, colours: 256, effort: 10 })
    .toBuffer();

  /*
    The buffer is written as it is, never re-encoded through `toFile`. Handing
    the quantised bytes back to sharp reopens and re-compresses them with
    default options — the palette is thrown away and the file comes out roughly
    twice the size, which is the opposite of the reason it was quantised. It
    read as a harmless "write it out" line and cost 42KB in the Worker bundle.
  */
  writeFileSync(output, png);
  const { width, height } = await sharp(output).metadata();
  if (width !== WIDTH || height !== HEIGHT) {
    throw new Error(`wrote ${width}x${height}, expected ${WIDTH}x${HEIGHT}`);
  }
  console.log(
    `wrote src/og-card.png — ${WIDTH}x${HEIGHT}, ${png.byteLength} bytes, ${faces} face(s)`,
  );
} finally {
  await browser.close();
}
