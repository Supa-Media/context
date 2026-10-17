// node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
// Photographs the HTML `trash-shots.ts` wrote, at the width each was drawn for. Chromium from PW_EXE, never downloaded.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = resolve(process.argv[2]);
const SHOTS = resolve(process.argv[3] ?? join(DIR, "shots"));
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
for (const name of readdirSync(DIR).filter((n) => n.endsWith(".html"))) {
  const stem = name.replace(/\.html$/, "");
  const desktop = stem.endsWith("-desktop");
  const page = await browser.newPage({
    viewport: desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 },
    deviceScaleFactor: desktop ? 1 : 2,
  });
  await page.goto(pathToFileURL(join(DIR, name)).toString());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${stem}.png`) });
  await page.close();
  console.log(`wrote ${stem}.png`);
}
await browser.close();
