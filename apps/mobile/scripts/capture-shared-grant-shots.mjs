// node scripts/capture-shared-grant-shots.mjs <html-dir> [png-dir]
// Photographs the HTML `shared-grant-shots.ts` wrote: `-desktop` at 1440, `-phone` at 390.
// Chromium from PW_EXE (or Playwright's own install), never downloaded.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = resolve(process.argv[2]);
const SHOTS = resolve(process.argv[3] ?? join(DIR, "shots"));
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch(process.env.PW_EXE ? { executablePath: process.env.PW_EXE } : {});
for (const name of readdirSync(DIR).filter((n) => n.endsWith(".html"))) {
  const stem = name.replace(/\.html$/, "");
  const desktop = stem.endsWith("-desktop");
  const viewport = desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const page = await browser.newPage({ viewport, deviceScaleFactor: desktop ? 1 : 2 });
  await page.goto(pathToFileURL(join(DIR, name)).toString());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${stem}.png`) });
  await page.close();
  console.log(`wrote ${stem}.png`);
}
await browser.close();
