#!/usr/bin/env node
/**
 * Build the standalone drawing editor and put its fonts beside it.
 *
 * ## Why the editor is a page instead of part of the console
 *
 * Measured, not assumed. Importing `@excalidraw/excalidraw` into the console
 * behind a dynamic `import()` does **not** produce a lazy chunk under Expo's
 * Metro: `expo export --platform web` put it in a `__common` bundle that
 * `index.html` loads with a plain blocking `<script src>`, taking the console's
 * total JavaScript from 5.7MB to 14.6MB on every page load — for a feature most
 * sessions never open. Built this way instead, the console's bundle is
 * unchanged and this artifact (2.4MB gzipped) is fetched the first time
 * somebody opens a drawing.
 *
 * It also stops the native half being a separate implementation: the console
 * loads this same page in an `<iframe>` on web and a `WebView` on native.
 *
 * ## Not committed, built
 *
 * The output is ignored by git, for the reason the fonts are: it is megabytes
 * of a dependency's code, and a committed copy is a second thing to keep in
 * step with every version bump — the failure `bundle.generated.ts` needs a
 * whole CI job to prevent. Building it means the version served is the version
 * installed, with nothing to drift.
 *
 * Run by `apps/mobile`'s `drawing-assets` script and by `deploy-web.yml` before
 * `expo export`. Idempotent: it clears its own output first, so a font family
 * dropped from the list stops being deployed rather than lingering.
 */

import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOBILE = path.join(ROOT, "apps", "mobile");
const SOURCE = path.join(MOBILE, "drawing-editor");
const PACKAGE = path.join(MOBILE, "node_modules", "@excalidraw", "excalidraw", "dist", "prod");
const OUT = path.join(MOBILE, "public", "drawing-assets");

/**
 * The families copied next to the bundle, read from the console's own module so
 * the list has one home.
 *
 * `drawingAssets.ts` explains why `Xiaolai` is excluded (13MB on its own) and
 * is where the decision changes if that stops being the right trade.
 */
async function bundledFamilies() {
  const source = path.join(MOBILE, "features", "console", "files", "drawingAssets.ts");
  const text = await readFile(source, "utf8");
  const block = /BUNDLED_FONT_FAMILIES = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text);
  if (!block) throw new Error(`could not read BUNDLED_FONT_FAMILIES from ${source}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/**
 * The page itself.
 *
 * Deliberately minimal, and with the canvas filling the frame: the console
 * sizes the iframe, and a page with its own margins would show as a gap the
 * console cannot see to remove. No inline script beyond the module tag, so the
 * page carries no behaviour that is not in the bundle it names.
 */
function pageHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <meta name="referrer" content="origin" />
    <title>Drawing</title>
    <link rel="stylesheet" href="./editor.css" />
    <style>
      html, body, #root { height: 100%; margin: 0; padding: 0; }
      #root { display: flex; }
      .excalidraw { flex: 1; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./editor.js"></script>
  </body>
</html>
`;
}

async function main() {
  if (!existsSync(PACKAGE)) {
    console.error(
      "@excalidraw/excalidraw is not installed. Run `pnpm install` first — this script builds " +
        "from the installed package on purpose, so the version served is the version installed."
    );
    process.exit(1);
  }

  const families = await bundledFamilies();

  // Clear first: anything dropped from the list must stop being deployed.
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, "editor"), { recursive: true });

  const result = await build({
    entryPoints: [path.join(SOURCE, "entry.jsx")],
    bundle: true,
    format: "esm",
    minify: true,
    sourcemap: false,
    target: ["es2020"],
    // Excalidraw reads this to pick its production build; without it the
    // development bundle ships, which is larger and logs to the console.
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: path.join(OUT, "editor", "editor.js"),
    // Its stylesheet is a real file the page has to load; esbuild writes it
    // beside the bundle under the same base name.
    loader: { ".woff2": "file", ".ttf": "file" },
    logLevel: "warning",
    metafile: true,
  });

  // The package's own stylesheet, copied rather than imported: importing it
  // from the entry would inline it into the JavaScript, which delays first
  // paint behind the whole bundle.
  await cp(path.join(PACKAGE, "index.css"), path.join(OUT, "editor", "editor.css"));
  await writeFile(path.join(OUT, "editor", "index.html"), pageHtml());

  const fonts = path.join(OUT, "editor", "fonts");
  await mkdir(fonts, { recursive: true });
  let fontBytes = 0;
  for (const family of families) {
    const from = path.join(PACKAGE, "fonts", family);
    if (!existsSync(from)) {
      console.error(
        `font family "${family}" is listed in drawingAssets.ts but not in the installed package. ` +
          "Shipping a build that silently falls back to a CDN is what this check exists to prevent."
      );
      process.exit(1);
    }
    await cp(from, path.join(fonts, family), { recursive: true });
    for (const file of await readdir(path.join(fonts, family))) {
      fontBytes += (await stat(path.join(fonts, family, file))).size;
    }
  }

  const bundleBytes = (await stat(path.join(OUT, "editor", "editor.js"))).size;
  console.log(
    `built the drawing editor: ${(bundleBytes / 1048576).toFixed(2)}MB of script and ` +
      `${(fontBytes / 1024).toFixed(0)}KB of fonts for ${families.length} families, ` +
      "into apps/mobile/public/drawing-assets/editor"
  );
  if (result.warnings.length > 0) console.log(`${result.warnings.length} esbuild warning(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
