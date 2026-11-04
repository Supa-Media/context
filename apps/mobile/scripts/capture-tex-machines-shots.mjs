// node scripts/capture-tex-machines-shots.mjs [html-dir] [png-dir]
// Photographs the HTML `tex-machines-shots.ts` wrote: full page, phone at 390 (dsf 2) and desktop at 1440 (dsf 2),
// named NN-name[-dark]-{desktop,phone}.png. Chromium from PW_EXE when set, else Playwright's own.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = resolve(process.argv[2] ?? process.env.TEX_MACHINES_SHOTS_DIR ?? "/tmp/tex-machines-shots/html");
const SHOTS = resolve(process.argv[3] ?? process.env.TEX_MACHINES_SHOTS_OUT ?? "/tmp/tex-machines-shots/png");
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_EXE || undefined });
for (const name of readdirSync(DIR).filter((n) => n.endsWith(".html")).sort()) {
  const stem = name.replace(/\.html$/, "");
  const desktop = stem.endsWith("-desktop");
  const page = await browser.newPage({
    viewport: desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  await page.goto(pathToFileURL(join(DIR, name)).toString());
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${stem}.png`), fullPage: true });
  await page.close();
  console.log(`wrote ${stem}.png`);
}
await browser.close();
