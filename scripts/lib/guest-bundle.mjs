/**
 * Building a guest bundle: a browser script for a `WebView` in the phone app,
 * committed as a generated TypeScript module and checked to be current.
 *
 * Shared by `build-editor-bundle.mjs` (the note editor) and
 * `build-map-bundle.mjs` (the live map). The argument for committing a
 * generated bundle at all is in the editor script's header; this is the part
 * both need: run esbuild for Safari 15, and record a SHA-256 of every
 * repository file and the version of every npm package that went in, from
 * esbuild's own metafile.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..", "..");
export const mobileRoot = join(repoRoot, "apps", "mobile");

const require = createRequire(import.meta.url);

function loadEsbuild() {
  try {
    return require("esbuild");
  } catch {
    console.error(
      "esbuild was not found. It is installed at the workspace root as a\n" +
        "transitive dependency of `convex`; run `pnpm install` from the repo root.",
    );
    process.exit(1);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The npm package a `node_modules/...` input belongs to, scope included. */
function packageOf(input) {
  const parts = input.split("/");
  const at = parts.lastIndexOf("node_modules");
  if (at === -1) return null;
  const first = parts[at + 1];
  if (first === undefined) return null;
  return first.startsWith("@") ? `${first}/${parts[at + 2]}` : first;
}

function versionOf(input) {
  // esbuild reports inputs relative to `absWorkingDir`, so a dependency arrives
  // as `../../node_modules/.pnpm/@codemirror+view@6.43.9/node_modules/…`. The
  // package root is what sits under the *last* `node_modules` segment.
  const parts = resolve(mobileRoot, input).split(sep);
  const at = parts.lastIndexOf("node_modules");
  const depth = parts[at + 1]?.startsWith("@") ? 3 : 2;
  const dir = parts.slice(0, at + depth).join(sep);
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const sorted = (record) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/**
 * Bundle `entry` (absolute) into one minified browser script. Returns the
 * code, the repository sources by SHA-256 (paths relative to the repo root),
 * the npm packages by version, and the esbuild version that produced it.
 */
export async function buildGuestBundle(entry) {
  const esbuild = loadEsbuild();
  // Which esbuild answered matters: it decides the minified bytes, and it is
  // resolved from the workspace root rather than declared anywhere, so it can
  // move without a single line of this repository changing.
  const esbuildVersion =
    JSON.parse(readFileSync(require.resolve("esbuild/package.json"), "utf8")).version ??
    "unknown";
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    // The oldest Safari an Expo 54 build can land on. Not `esnext`: what runs
    // this is WKWebView on whatever iOS the person has, not the machine that
    // built it.
    target: ["safari15"],
    platform: "browser",
    legalComments: "none",
    write: false,
    metafile: true,
    absWorkingDir: mobileRoot,
  });
  const code = result.outputFiles[0].text;
  const sources = {};
  const dependencies = {};
  for (const input of Object.keys(result.metafile.inputs)) {
    const pkg = packageOf(input);
    if (pkg === null) {
      // esbuild reports inputs relative to `absWorkingDir`; record them relative
      // to the repo root so the test can find them from anywhere.
      const absolute = resolve(mobileRoot, input);
      sources[relative(repoRoot, absolute).split(sep).join("/")] = sha256(readFileSync(absolute));
    } else if (dependencies[pkg] === undefined) {
      dependencies[pkg] = versionOf(input);
    }
  }
  return { code, sources, dependencies, esbuildVersion };
}
