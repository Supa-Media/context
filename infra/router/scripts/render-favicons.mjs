/**
 * Render the site icons in `src/` from the app's one favicon vector,
 * `apps/mobile/assets/source/favicon.svg`.
 *
 *   node scripts/render-favicons.mjs
 *
 * They ship inside the Worker (see `src/icons.ts`) because a search engine's
 * favicon fetcher is a crawler like any other: it should never depend on an
 * upstream that might be mid-deploy, or on a SPA fallback that answers a
 * missing file with HTML.
 *
 * Sizes follow what Google's favicon guidelines ask for: square, a multiple of
 * 48px. The apple-touch-icon is flattened onto the ground because iOS fills
 * transparent corners with black and then rounds them itself.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(
  resolve(here, "../../../apps/mobile/assets/source/favicon.svg"),
  "utf8",
).replace(/<!--[\s\S]*?-->/g, "");

const OUTPUTS = [
  { file: "favicon-48.png", size: 48, ground: null },
  { file: "favicon-192.png", size: 192, ground: null },
  { file: "apple-touch-icon.png", size: 180, ground: "#050506" },
];

const browser = await chromium.launch();
try {
  for (const { file, size, ground } of OUTPUTS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const sized = svg.replace('width="256" height="256"', `width="${size}" height="${size}"`);
    await page.setContent(
      `<body style="margin:0;background:${ground ?? "transparent"}">${sized}</body>`,
    );
    await page.screenshot({
      path: resolve(here, "../src", file),
      omitBackground: ground === null,
      clip: { x: 0, y: 0, width: size, height: size },
    });
    await page.close();
  }
} finally {
  await browser.close();
}
