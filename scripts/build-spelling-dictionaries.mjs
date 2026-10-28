#!/usr/bin/env node
/**
 * Put the note editor's spelling dictionaries where the web app serves them:
 * `apps/mobile/public/spelling/<language>.aff` and `.dic`.
 *
 * Hunspell files from the `dictionary-*` packages (MIT AND BSD, from SCOWL),
 * fetched by `features/console/files/spelling/store.ts` the first time a note
 * is opened — about 190KB gzipped for each language — rather than built into
 * the console's JavaScript, which every page load pays for.
 *
 * Built, not committed, for `build-drawing-editor.mjs`'s reason: a committed
 * copy is a second thing to keep in step with the installed package. Run by
 * that script (so every workflow that builds the drawing editor builds these
 * too) and idempotent: it clears its own output first.
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE = path.join(ROOT, "apps", "mobile");
const OUT = path.join(MOBILE, "public", "spelling");

/** Language key (as `SPELLING_LANGUAGES` in `store.ts` spells it) to package. */
const DICTIONARIES = [
  ["en-US", "dictionary-en"],
  ["en-GB", "dictionary-en-gb"],
];

export async function buildSpellingDictionaries() {
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  let bytes = 0;
  for (const [language, pkg] of DICTIONARIES) {
    const from = path.join(MOBILE, "node_modules", pkg);
    if (!existsSync(path.join(from, "index.dic"))) {
      throw new Error(`${pkg} is not installed in apps/mobile; the ${language} dictionary would be missing.`);
    }
    for (const ext of ["aff", "dic"]) {
      await cp(path.join(from, `index.${ext}`), path.join(OUT, `${language}.${ext}`));
      bytes += (await stat(path.join(OUT, `${language}.${ext}`))).size;
    }
    await cp(path.join(from, "license"), path.join(OUT, `${language}.license.txt`));
  }
  console.log(`copied ${DICTIONARIES.length} spelling dictionaries (${(bytes / 1048576).toFixed(2)}MB) into apps/mobile/public/spelling`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildSpellingDictionaries().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
