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
const frames = [...new Set([...html.matchAll(/data-frame="([^"]+)"/g)].map((m) => m[1]))];
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
      viewport: { width: viewport.width + 320, height: viewport.height + 140 },
      deviceScaleFactor: density === "phone" ? 2 : 1,
    });
    await page.goto(`${pathToFileURL(PAGE).toString()}#${frame}/${density}/dark`);
    const shot = page.locator(
      `.viewport[data-frame="${frame}"][data-density="${density}"][data-theme="dark"]`,
    );
    await shot.waitFor({ state: "visible" });
    /*
      The still is the whole frame, not the part of it that fits.

      In the prototype a frame is a fixed 390x844 or 1440x900 box you scroll
      inside, which is what makes it a device. A *picture* of a state that stops
      at the fold is the failure mode this pack exists to avoid — the confirm
      screen's price and export promise are both below it — so the box is
      released to its content height before the shutter and the element is
      photographed rather than the page. The width, which is what the layout
      actually depends on, is untouched.
    */
    await shot.evaluate((node) => {
      node.style.height = "auto";
      node.style.overflow = "visible";
      const app = node.firstElementChild;
      if (app instanceof HTMLElement) {
        app.style.height = "auto";
        app.style.maxHeight = "none";
      }
    });
    await shot.screenshot({ path: join(SHOTS, `${frame}-${density}.png`) });
    await page.close();
    console.log(`wrote shots/${frame}-${density}.png`);
  }
}

await browser.close();
