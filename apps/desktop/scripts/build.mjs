/**
 * One esbuild pass over the three worlds this app has.
 *
 * Electron will not run TypeScript, so something has to bundle it. esbuild
 * rather than a framework because there are exactly six entry points and no
 * framework would be doing anything else:
 *
 *  - **main** — the Node side. **CommonJS**, for the reason spelled out above
 *    the config: an ESM main process bundles CommonJS dependencies behind a
 *    `require` shim that throws, and that shipped. `electron` is external,
 *    because it is provided by the runtime and bundling it is a category error.
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

/**
 * Whether *this* build is code-signed, decided here rather than read live by
 * the packaged app.
 *
 * `deploy-desktop.yml`'s certificate step already knows — it is the one that
 * either builds a keychain or gives up and sets `CSC_IDENTITY_AUTO_DISCOVERY`
 * — and passes it as `CONTEXT_DESKTOP_SIGNED` to this build, not to the packaged
 * app: a double-clicked `.app` on somebody's Mac carries none of the
 * environment a GitHub Actions runner set. Baked in as a literal instead, so
 * `src/core/update/policy.ts`'s `shouldArmUpdater` — the check that decides
 * whether `autoUpdater` is ever constructed — has a real answer instead of a
 * guess. Unset locally, which is correct: nothing built on a laptop is signed.
 */
const SIGNED = process.env.CONTEXT_DESKTOP_SIGNED === "true";

/*
  ── THE MAIN PROCESS IS COMMONJS, AND THAT IS THE FIX FOR A DEAD BUILD ──────

  ## What shipped

  `electron-updater` and its `builder-util-runtime` dependency are CommonJS and
  call `require("events")` when they load. Bundled into an **ESM** main process,
  esbuild inlines them and emits its own shim for the calls it cannot resolve
  statically:

    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');

  In an ES module `require` is not defined, so that shim took the second branch
  on the *first line of the app*. Every build since electron-updater arrived
  was dead on launch — signed, notarised, stapled, and greeted by `A JavaScript
  error occurred in the main process` before `app.whenReady()`. Nothing caught
  it because nothing in this repository had ever *started* the app.
  `test/launch.smoke.mjs` is that check now.

  ## Why `format: "cjs"` and not the two alternatives

  The main process is a CommonJS world: Electron's own main-process ecosystem,
  electron-builder and electron-updater are all CJS, and nothing in `src/main/`
  needs an ES module. Building it as one bought nothing and cost the app. As
  CJS, `require` is genuinely real, esbuild emits **no shim at all** — the built
  bundle contains zero occurrences of `Dynamic require of`, which is asserted by
  the launch check — and this config now says the same thing as the three
  preload configs below it, for the same reason.

  Both alternatives were built and measured rather than argued about:

   - **`external: ["electron-updater"]`, packaged from `node_modules`.** It does
     remove the shim, and then the app does not start *at all*, not even in
     development: esbuild emits `import { autoUpdater } from "electron-updater"`,
     Node's ESM loader cannot see a named export on a CommonJS module, and the
     link fails with `SyntaxError: Named export 'autoUpdater' not found` — the
     same launch-time death, a different sentence. Making it work needs
     `src/main/updater.ts` rewritten to a default import plus a destructure
     **and** `files:` in `electron-builder.yml` extended to carry
     electron-updater and its whole transitive tree into the asar — which pnpm
     puts under `node_modules/.pnpm/electron-updater@6.3.9/node_modules/`, not
     where a flat glob would find it, and which would falsify that file's own
     "`node_modules` is not copied because every runtime dependency is bundled".
     Two source changes and a packaging change, to close the hazard for exactly
     one package.
   - **A `createRequire(import.meta.url)` banner over the ESM bundle.** Two
     lines, and it does work — verified by launching it. But it leaves esbuild's
     `Dynamic require of` shim in the shipped bundle, merely unreachable,
     so the property worth asserting ("this bundle cannot throw that") becomes
     unassertable. It also puts a top-level `const require` into an ES module,
     one collision away from a `SyntaxError`.

  The cost of CJS, stated so nobody rediscovers it: `"type": "module"` in
  `package.json` means the output has to be `dist/main/index.cjs`, `main` and
  `start` name that file, and `src/main/index.ts` uses `__dirname` rather than
  `import.meta.dirname` — which esbuild warns about and silently empties in a
  CJS build. That last one is load-bearing (it is how the preloads are found)
  and is why the launch check reports whether `RENDERER_DIR` exists.
*/

const configs = [
  {
    entryPoints: [join(root, "src/main/index.ts")],
    outfile: join(out, "main/index.cjs"),
    platform: "node",
    format: "cjs",
    target: NODE_TARGET,
    external: ["electron"],
    define: { __CONTEXT_DESKTOP_SIGNED__: JSON.stringify(SIGNED) },
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
  {
    // The console window's bridge. CJS for the same reason as the other two,
    // and doubly so here: this preload runs sandboxed, where an ESM one does
    // not merely misbehave, it never runs at all — a window that loads, looks
    // right, and has no `window.desktop` on it.
    entryPoints: [join(root, "src/preload/console.ts")],
    outfile: join(out, "renderer/consolePreload.js"),
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
