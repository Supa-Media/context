#!/usr/bin/env node
/**
 * Build the live map guest bundle that the phone app runs inside its `WebView`.
 *
 *     node scripts/build-map-bundle.mjs
 *
 * The map's engine draws on a `<canvas>`, which React Native does not have.
 * Rather than draw the map a second way, the app runs the same engine in a web
 * view. Why that is a committed, generated file rather than a fetch or a build
 * step is the editor's argument (`build-editor-bundle.mjs`) and holds the same
 * here: the app ships over the air with a pinned runtime, and the map must
 * open with no network. `__tests__/mapBundle.test.ts` fails when a source
 * changed and this was not re-run; the `editor-bundle` job in `ci.yml`
 * rebuilds both bundles and fails when the committed bytes differ.
 */

import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildGuestBundle, mobileRoot, repoRoot, sorted } from "./lib/guest-bundle.mjs";

const folder = join(mobileRoot, "features", "console", "map", "live", "webview");
const entry = join(folder, "entry.ts");
const out = join(folder, "bundle.generated.ts");

const { code, sources, dependencies, esbuildVersion } = await buildGuestBundle(entry);

const header = `/**
 * GENERATED — do not edit.
 *
 * The live map's canvas engine, compiled for the phone app's web view by
 * \`scripts/build-map-bundle.mjs\`. Re-run that script after any change to the
 * files listed in \`BUNDLE_SOURCES\`; \`__tests__/mapBundle.test.ts\` fails if
 * you do not.
 */

/** Every file in this repository that went into the bundle, by SHA-256. */
export const BUNDLE_SOURCES: Readonly<Record<string, string>> = ${JSON.stringify(sorted(sources), null, 2)};

/** Every npm package that went into the bundle, at the version it was built from. */
export const BUNDLE_DEPENDENCIES: Readonly<Record<string, string>> = ${JSON.stringify(sorted(dependencies), null, 2)};

/** The bundler that produced the bytes below. */
export const BUNDLE_BUILDER: Readonly<{ esbuild: string }> = ${JSON.stringify({ esbuild: esbuildVersion }, null, 2)};

/** The bundle itself, one minified line. */
export const MAP_BUNDLE: string = ${JSON.stringify(code)};
`;

writeFileSync(out, header);

const kb = (n) => `${(n / 1024).toFixed(1)}kb`;
console.log(
  `wrote ${relative(repoRoot, out)} — ${kb(code.length)} of script, ` +
    `${Object.keys(sources).length} repo sources, ` +
    `${Object.keys(dependencies).length} packages`,
);
