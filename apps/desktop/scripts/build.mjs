/**
 * One esbuild pass over the three worlds this app has.
 *
 * Electron will not run TypeScript, so something has to bundle it. esbuild
 * rather than a framework because there are exactly six entry points and no
 * framework would be doing anything else:
 *
 *  - **main** — the Node side. `electron` is external, because it is provided
 *    by the runtime and bundling it is a category error.
 *  - **preload** — CommonJS, not ESM. Electron's preloads are `require`d, and
 *    an ESM preload silently does nothing, which is the failure mode where the
 *    window loads, looks right, and has no `window.context` on it.
 *  - **renderer** — the browser side, ESM, with no Node in it at all.
 *
 * HTML and CSS are copied rather than processed. They are hand-written and
 * small, and a pipeline over them would be a build step nobody can read.
 *
 * `--watch` rebuilds on change; run `pnpm start` in another terminal.
 */

import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const watch = process.argv.includes("--watch");

/** Everything is pinned to the Node and Chromium that Electron 33 ships. */
const NODE_TARGET = "node20";
const CHROME_TARGET = "chrome128";

const configs = [
  {
    entryPoints: [join(root, "src/main/index.ts")],
    outfile: join(out, "main/index.js"),
    platform: "node",
    format: "esm",
    target: NODE_TARGET,
    external: ["electron"],
  },
  {
    entryPoints: [join(root, "src/preload/index.ts")],
    outfile: join(out, "renderer/preload.js"),
    platform: "node",
    format: "cjs",
    target: NODE_TARGET,
    external: ["electron"],
  },
  {
    entryPoints: [join(root, "src/preload/capture.ts")],
    outfile: join(out, "renderer/capturePreload.js"),
    platform: "node",
    format: "cjs",
    target: NODE_TARGET,
    external: ["electron"],
  },
  ...["panel", "notepad", "capture"].map((name) => ({
    entryPoints: [join(root, `src/renderer/${name}.ts`)],
    outfile: join(out, `renderer/${name}.js`),
    platform: "browser",
    format: "esm",
    target: CHROME_TARGET,
  })),
].map((config) => ({ ...config, bundle: true, sourcemap: true, logLevel: "info" }));

async function copyStatic() {
  await mkdir(join(out, "renderer"), { recursive: true });
  for (const file of [
    "panel.html",
    "panel.css",
    "notepad.html",
    "notepad.css",
    "capture.html",
    "tokens.css",
  ]) {
    await cp(join(root, "src/renderer", file), join(out, "renderer", file));
  }
}

await rm(out, { recursive: true, force: true });
await copyStatic();

if (watch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("watching — run `pnpm start` in another terminal");
} else {
  await Promise.all(configs.map((config) => build(config)));
}
