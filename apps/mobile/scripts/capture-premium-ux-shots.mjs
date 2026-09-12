/**
 * Photographs every frame in the prototype `premium-ux-shots.ts` wrote.
 *
 * The division of labour `capture-ux-audit-shots.mjs` describes, with one
 * difference: there is one document rather than one per surface, so this drives
 * it through the hash its own runtime already reads (`#frame/density/theme`)
 * and photographs the visible viewport element rather than the page — the page
 * carries the prototype's own chrome, which is not part of any picture.
 *
 * Run the renderer first — the two are one step, in this order:
 *
 *   pnpm exec jest --testMatch '**\/scripts/premium-ux-shots.ts' --testPathIgnorePatterns '[]'
 *   node scripts/capture-premium-ux-shots.mjs
 *
 * `PREMIUM_UX_SHOT_DIR` points both at the same place; unset, both use
 * `docs/design/premium-ux/`.
 *
 * **Dark only, and that is a size decision rather than a judgement about which
 * palette matters.** Both palettes are in the prototype and one press apart;
 * doubling the pictures would put ~4MB of PNG in a public repository to say
 * twice what a reviewer can already see. Where a state's colour is the point —
 * the warn wash on a failure, the ok wash on a success — the light half is
 * worth opening the prototype for.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(
  process.env.PREMIUM_UX_SHOT_DIR ?? resolve(HERE, "../../../docs/design/premium-ux"),
);
const SHOTS = join(DIR, "shots");
const PAGE = join(DIR, "prototype.html");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

mkdirSync(SHOTS, { recursive: true });

/*
  The frame list is read off the document rather than re-declared here: a
  capture script carrying its own copy of the catalogue is a capture script that
  silently stops photographing whatever was added last.
*/
const html = readFileSync(PAGE, "utf8");
const frames = [...new Set([...html.matchAll(/class="cell"[^>]*data-frame="([^"]+)"/g)].map((m) => m[1]))];
if (frames.length === 0) {
  console.error(`no frames in ${PAGE} — run the renderer first (see the header)`);
  process.exit(1);
}

const browser = await chromium.launch();

for (const frame of frames) {
  for (const density of ["phone", "desktop"]) {
    const viewport = density === "phone" ? PHONE : DESKTOP;
    // Retina for the phone, one-to-one for the pointer layout — the trade
    // `capture-ux-audit-shots.mjs` argues: 390pt of glass has to stay legible
    // when the file is opened at any size, and 1440px already is.
    const page = await browser.newPage({
      viewport: { width: viewport.width + 360, height: viewport.height + 200 },
      deviceScaleFactor: density === "phone" ? 2 : 1,
    });
    await page.goto(`${pathToFileURL(PAGE).toString()}#${frame}/${density}/dark`);
    const cell = page.locator(
      `.cell[data-frame="${frame}"][data-density="${density}"][data-theme="dark"]`,
    );
    await cell.waitFor({ state: "visible" });
    /*
      The still is the device at 1:1, not the fitted-to-the-window copy the
      page shows.

      `scale(1)` rather than `none`: the transform is what makes `.viewport` the
      containing block for the settings overlay, which is `position: fixed`.
      Remove it and the overlay escapes its device and sizes itself to the
      browser window — which is exactly the bug these stills were re-shot for.
    */
    await cell.evaluate((node) => {
      const view = node.querySelector(".viewport");
      const screen = node.querySelector(".screen");
      view.style.transform = "scale(1)";
      screen.style.width = view.style.width;
      screen.style.height = "auto";
      view.style.height = "auto";
      const app = view.firstElementChild;
      if (app instanceof HTMLElement) {
        app.style.height = "auto";
        app.style.maxHeight = "none";
      }
    });
    await cell.locator(".device").screenshot({ path: join(SHOTS, `${frame}-${density}.png`) });
    await page.close();
    console.log(`wrote shots/${frame}-${density}.png`);
  }
}

await browser.close();
