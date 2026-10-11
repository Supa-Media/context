#!/usr/bin/env node
/**
 * Build the Live Preview guest bundle that iOS runs inside its `WebView`.
 *
 *     node scripts/build-editor-bundle.mjs
 *
 * ## Why there is a generated file in the tree at all
 *
 * The editor is CodeMirror, and CodeMirror is fourteen ES modules that a
 * browser has to be handed as one script. Metro cannot produce that script:
 * Metro bundles for Hermes, and what has to reach WKWebView is browser code
 * that never enters the React Native module graph — if CodeMirror ever *did*
 * enter it, that is precisely the "a DOM library in apps/mobile" move that
 * `supa-framework.test.js`'s React-resolution guard exists to catch.
 *
 * So something else has to bundle it, and the options were: fetch it (no — the
 * app works offline and the note lives in a bucket the customer owns; an editor
 * that phones a CDN to open a file is not that product), build it during
 * `expo export` (no — `runtimeVersion` is pinned forever, every change ships
 * over the air, and an OTA bundle that needs a build step nobody ran is a blank
 * editor on a phone), or generate it once, commit it, and check it is current.
 *
 * ## What keeps it honest
 *
 * A committed artifact rots the moment somebody edits `livePreview.ts` and does
 * not re-run this. So the generated file records, beside the code:
 *
 *  - a SHA-256 of every **repo** file that went into the bundle, and
 *  - the resolved version of every **npm package** that went into it,
 *
 * both taken from esbuild's own metafile rather than from a list somebody
 * maintains. `__tests__/editorBundle.test.ts` recomputes both and fails if
 * either has moved. That is a guard that can be checked without this script
 * being installed, which is the point — "a guard nobody has checked is not a
 * guard".
 *
 * esbuild is not a declared dependency of `apps/mobile` and deliberately is not
 * added as one: it is reached through the workspace root, where `convex` (a
 * root devDependency) already installs it. Adding it to `apps/mobile` would put
 * a bundler in the dependency tree of a React Native app for the sake of a file
 * that is regenerated a handful of times a year, and every dependency added
 * there is another chance to re-key the native module graph.
 */

import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildGuestBundle, mobileRoot, repoRoot, sorted } from "./lib/guest-bundle.mjs";

const entry = join(mobileRoot, "features", "console", "files", "webview", "entry.ts");
const out = join(mobileRoot, "features", "console", "files", "webview", "bundle.generated.ts");

const { code, sources, dependencies, esbuildVersion } = await buildGuestBundle(entry);

const header = `/**
 * GENERATED — do not edit.
 *
 * The CodeMirror Live Preview editor, compiled for WKWebView by
 * \`scripts/build-editor-bundle.mjs\`. Re-run that script after any change to
 * the files listed in \`BUNDLE_SOURCES\`; \`__tests__/editorBundle.test.ts\`
 * fails if you do not.
 *
 * The code below is CodeMirror (MIT, Marijn Haverbeke and others), lezer (MIT)
 * and this repository's own \`livePreview.ts\` / \`editorSetup.ts\`, minified
 * into one script so the editor opens with no network at all. See the script's
 * own comment for why it is committed rather than built.
 */

/** Every file in this repository that went into the bundle, by SHA-256. */
export const BUNDLE_SOURCES: Readonly<Record<string, string>> = ${JSON.stringify(sorted(sources), null, 2)};

/** Every npm package that went into the bundle, at the version it was built from. */
export const BUNDLE_DEPENDENCIES: Readonly<Record<string, string>> = ${JSON.stringify(sorted(dependencies), null, 2)};

/**
 * The bundler that produced the bytes below.
 *
 * Recorded because the bytes depend on it and nothing else here does. Adding
 * esbuild as a devDependency of a *different* workspace package once moved the
 * root resolution, and the committed bundle stopped matching its sources while
 * \`BUNDLE_SOURCES\` and \`BUNDLE_DEPENDENCIES\` were byte-identical — so the
 * integrity job fired with no way for a reviewer to see it was a compiler bump
 * rather than the injected code it exists to catch.
 */
export const BUNDLE_BUILDER: Readonly<{ esbuild: string }> = ${JSON.stringify({ esbuild: esbuildVersion }, null, 2)};

/**
 * The bundle itself.
 *
 * One long line on purpose: it is minified output, and reflowing it would make
 * every rebuild a whole-file diff for no reader's benefit.
 */
export const EDITOR_BUNDLE: string = ${JSON.stringify(code)};
`;

writeFileSync(out, header);

const kb = (n) => `${(n / 1024).toFixed(1)}kb`;
console.log(
  `wrote ${relative(repoRoot, out)} — ${kb(code.length)} of script, ` +
    `${Object.keys(sources).length} repo sources, ` +
    `${Object.keys(dependencies).length} packages`,
);
