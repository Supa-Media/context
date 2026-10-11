// node scripts/capture-chaos-shots.mjs <html-dir> <png-dir>
// Photographs the HTML `chaos-shots.ts` wrote. Chromium from PW_EXE, never downloaded.
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
  const viewport = stem.includes("-figures-")
    ? { width: 1300, height: 420 }
    : stem.includes("-desktop-")
      ? { width: 1440, height: 900 }
      : { width: 390, height: 844 };
  const page = await browser.newPage({ viewport, deviceScaleFactor: stem.includes("-desktop-") ? 1 : 2 });
  await page.goto(pathToFileURL(join(DIR, name)).toString());
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    if (!document.querySelector('meta[name="chaos-scroll"]')) return;
    for (const el of document.body.querySelectorAll("*")) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) el.scrollTop = el.scrollHeight;
    }
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, `${stem}.png`) });
  await page.close();
  console.log(`wrote ${stem}.png`);
}
await browser.close();
