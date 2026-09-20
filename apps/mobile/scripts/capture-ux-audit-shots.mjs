/**
 * Photographs every `.html` `ux-audit-shots.ts` wrote, at the size its name
 * says.
 *
 * `capture-shell-band-shots.mjs`'s job and its division of labour: the `.html`
 * is the evidence of what the components render, the `.png` beside it is the
 * picture of that. Run the renderer first — the two are one step, in this
 * order:
 *
 *   pnpm exec jest --testMatch '**\/scripts/ux-audit-shots.ts' --testPathIgnorePatterns '[]'
 *   node scripts/capture-ux-audit-shots.mjs
 *
 * `UX_AUDIT_SHOT_DIR` points both at the same place; unset, both use
 * `docs/design/ux-audit/`.
 *
 * The density is read off the file name rather than passed in, because the
 * renderer already baked a fixed pixel box into each document — photographing a
 * 390-wide page in a 1440-wide window would frame the phone shots in a field of
 * page background and quietly change what every picture is of.
 */
import { chromium } from "@playwright/test";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(process.env.UX_AUDIT_SHOT_DIR ?? resolve(HERE, "../../../docs/design/ux-audit"));
const SHOTS = join(DIR, "shots");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

mkdirSync(SHOTS, { recursive: true });

const pages = readdirSync(DIR).filter((name) => name.endsWith(".html"));
if (pages.length === 0) {
  console.error(`no .html in ${DIR} — run the renderer first (see the header)`);
  process.exit(1);
}

const browser = await chromium.launch();

for (const name of pages) {
  const stem = name.replace(/\.html$/, "");
  const desktop = stem.includes("-desktop-");
  const viewport = desktop ? DESKTOP : PHONE;
  /*
    Retina for the phone, one-to-one for the pointer layout.

    Not a compromise between quality and repository weight so much as a
    recognition that they are different pictures: 390pt of glass has to be
    legible when somebody opens the file at any size, and 1440px already is.
    Doubling both would put ~8MB of PNG in a repository whose next-largest
    shot folder is 1.1MB.
  */
  const page = await browser.newPage({ viewport, deviceScaleFactor: desktop ? 1 : 2 });
  await page.goto(pathToFileURL(join(DIR, name)).toString());
  await page.screenshot({ path: join(SHOTS, `${stem}.png`) });
  await page.close();
  console.log(`wrote shots/${stem}.png`);
}

await browser.close();
