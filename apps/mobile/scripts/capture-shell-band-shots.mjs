/**
 * Opens the `.html` files `shell-band-shots.ts` writes to `docs/design/desktop/`
 * and photographs each at 1280×800 — the size the console window's own shot
 * uses. Not part of `pnpm test`; run once, by hand, after the `.html` files
 * exist:
 *
 *   pnpm exec jest --testMatch '**\/scripts/shell-band-shots.ts' --testPathIgnorePatterns '[]'
 *   node scripts/capture-shell-band-shots.mjs
 *
 * Same division of labour as every other `docs/design/*` folder in this repo:
 * the `.html` is the evidence of what the components render, checked in
 * beside the `.png` `shots/` folder that is the picture of it.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(HERE, "../../../docs/design/desktop");
const SHOTS = join(DIR, "shots");

const NAMES = ["sign-in-mac-shell", "console-mac-shell", "console-no-shell"];

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (const name of NAMES) {
  const url = pathToFileURL(join(DIR, `${name}.html`)).toString();
  await page.goto(url);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  console.log(`wrote ${join("shots", `${name}.png`)}`);
}

await browser.close();
