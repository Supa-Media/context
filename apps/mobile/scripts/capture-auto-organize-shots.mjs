// node scripts/capture-auto-organize-shots.mjs <dir> [only-substring]
// Photographs the HTML `auto-organize-shots.ts` wrote. Chromium from PW_EXE, never downloaded.
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = resolve(process.argv[2]);
const only = process.argv[3];
const SHOTS = join(DIR, "shots");
mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
for (const name of readdirSync(DIR).filter((n) => n.endsWith(".html") && (!only || n.includes(only)))) {
  const stem = name.replace(/\.html$/, "");
  const desktop = stem.includes("-desktop-");
  const viewport = desktop ? { width: 1440, height: 900 } : { width: 390, height: 844 };
  const page = await browser.newPage({ viewport, deviceScaleFactor: desktop ? 1 : 2 });
  await page.goto(pathToFileURL(join(DIR, name)).toString());
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    if (!document.querySelector('meta[name="ao-scroll"]')) return;
    const root = document.querySelector('[data-testid="settings-overlay"]') ?? document.body;
    for (const el of root.querySelectorAll("*")) {
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
