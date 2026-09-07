#!/usr/bin/env node
/**
 * The one check that starts the app.
 *
 * ## Why this file exists
 *
 * A signed, notarised build shipped that could not launch at all. It threw
 * `Error: Dynamic require of "events" is not supported` from the first line of
 * the main bundle, before `app.whenReady()`, and every person who installed it
 * got a modal crash dialog instead of an app. It went out through 922 passing
 * checks, a full CI run, a typecheck, a code signature, an Apple notarisation
 * and a Gatekeeper assessment — because **not one of those starts the process**.
 * The rest of `test/` is deliberately offline and Electron-free, which is right
 * for what it checks and is exactly why it could not see this.
 *
 * So this is the guard, and it is the only kind that could have worked: build
 * the app, run it in real Electron, and require it to report from the end of
 * `main()` and exit cleanly.
 *
 * ## What it proves, and what it does not
 *
 * It proves the shipped module graph **evaluates** — which is the whole of the
 * crash, since `src/main/updater.ts` imports `electron-updater` statically and
 * that import is what threw — and then that `main()` ran to its last line, that
 * a window exists, that macOS gave this process a tray, an application menu and
 * a Dock tile, and which address the console was pointed at.
 *
 * It is **not** an `ELECTRON_RUN_AS_NODE` smoke test, and that distinction is
 * the point rather than a detail: that variable makes the Electron binary run
 * as plain Node, which swaps the module loader, provides a real CommonJS
 * `require`, and never creates an `app` object at all. It would have loaded the
 * broken bundle without complaint. Nothing here sets it.
 *
 * What it deliberately does not exercise: the app is started with
 * `--fake-signals`, so the macOS collectors (`ps`, System Events, `ioreg`,
 * Calendar), the real recorder and the keychain-backed token store are swapped
 * for the deterministic fakes. That is a trade taken on purpose — the real
 * collectors raise an Automation permission dialog no runner can answer, and
 * `safeStorage` can raise a keychain prompt on an unsigned build. Everything
 * else is the shipped path: the real bundle, the real Electron main process,
 * the real window, tray, menu, Dock and console-address resolution.
 *
 * It also does not prove the page **rendered** — a window that loads a dead
 * address is still a window. What it does check is the address, which is the
 * fact that was wrong.
 *
 * ## Running it
 *
 *   pnpm --filter @context/desktop build
 *   pnpm --filter @context/desktop smoke                      # dist/main/index.cjs
 *   pnpm --filter @context/desktop smoke -- --app release/mac-arm64/Context.app
 *
 * The second form is the one that matters most: it starts the packaged `.app`,
 * inside its asar, with `app.isPackaged` true — which is what a person
 * double-clicks, and is where the console address differs from a dev launch.
 * `deploy-desktop.yml` runs both, and the packaged one runs after
 * electron-builder so no artifact is ever uploaded that nothing has started.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** How long the app gets to reach the end of `main()` and quit. */
const TIMEOUT_MS = 60_000;

/**
 * The addresses a launch is allowed to have resolved to.
 *
 * A packaged build must point at the product console and an unpackaged one at
 * `expo start`; getting this backwards is what shipped a blank window, so it is
 * asserted rather than printed. Both come from `core/shell/console.ts` and are
 * repeated here on purpose — a check that imports the constant it is checking
 * agrees with a typo.
 */
const PACKAGED_CONSOLE_URL = "https://context.lc/console";
const DEV_CONSOLE_URL = "http://localhost:8081/";

/** Every sentence Electron prints when the main process throws before ready. */
const CRASH_MARKERS = [
  "Dynamic require of",
  "App threw an error during load",
  "Uncaught Exception",
  "A JavaScript error occurred in the main process",
];

let failures = 0;
/**
 * Checks this run could not ask, counted so the summary line has to admit them.
 *
 * A skip here is never silent: it prints its own `SKIP` line with the reason,
 * and the last line of the run says how many there were. A green run that
 * skipped the offline row proves less than a green run that did not, and the
 * output has to say which one it was — otherwise the skip is a way of passing.
 */
let skipped = 0;

function check(label, condition, detail) {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition || !detail ? "" : ` — ${detail}`}`);
}

function skip(label, why) {
  skipped += 1;
  console.log(`SKIP  ${label} — ${why}`);
}

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
}

/**
 * What to run, and whether it is the packaged app.
 *
 * `--app` takes the `.app` bundle rather than the executable inside it, because
 * that is what `release/` holds and what a person installs; the executable's
 * name is the product name, read from the bundle rather than typed here.
 */
function target() {
  const appPath = argValue("--app");
  if (appPath === null) {
    const entry = join(root, "dist/main/index.cjs");
    if (!existsSync(entry))
      throw new Error(`${entry} does not exist — run \`pnpm --filter @context/desktop build\` first.`);
    return { command: electronBinary(), args: [entry], packaged: false, what: "dist/main/index.cjs" };
  }
  const bundle = resolve(appPath);
  const executable = join(bundle, "Contents", "MacOS", basename(bundle).replace(/\.app$/, ""));
  if (!existsSync(executable)) throw new Error(`${executable} does not exist — is ${bundle} a .app bundle?`);
  return { command: executable, args: [], packaged: true, what: basename(bundle) };
}

function electronBinary() {
  // The `electron` package's own main export is the path to the binary. Read
  // through `require` and not by guessing at `node_modules/electron/dist/...`,
  // which differs per platform.
  const binary = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string")
    throw new Error("the `electron` package did not export a path — is it installed?");
  return binary;
}

/**
 * Start it, collect everything it said, and answer how it ended.
 *
 * `flags` is what this launch is *for* — `--smoke` for the ordinary run, and
 * `--smoke-load` plus a dead proxy for the offline row at the bottom of this
 * file. Everything else about the launch is identical on purpose: the same
 * binary, the same `--fake-signals`, the same throwaway profile.
 */
function launch({ command, args, userDataDir, flags = ["--smoke"] }) {
  return new Promise((resolvePromise) => {
    /*
      `ELECTRON_RUN_AS_NODE` is *deleted* rather than merely not set — see this
      file's header. Inherited from an outer tool it would turn the Electron
      binary into plain Node, hand the bundle a real CommonJS `require`, create
      no `app` at all, and load the broken build without complaint: the exact
      test that proves nothing.
    */
    const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(command, [...args, "--fake-signals", ...flags, `--user-data-dir=${userDataDir}`], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ output, ...result });
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, timedOut: true });
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => finish({ code: null, timedOut: false, spawnError: error.message }));
    child.on("close", (code) => finish({ code, timedOut: false }));
  });
}

/** The one line the app is asked to print, parsed. */
function smokeReport(output) {
  const line = output.split("\n").find((each) => each.includes("[smoke] "));
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(line.indexOf("[smoke] ") + "[smoke] ".length));
  } catch {
    return null;
  }
}

/**
 * The sentence the app exited with — `[smoke] <why>`, the one `endSmoke` prints
 * that is not the JSON report. It is what a failing offline row should quote,
 * because "exit code 1" on its own sends a person back to the log.
 */
function lastSmokeLine(output) {
  const lines = output.split("\n").filter((each) => each.includes("[smoke] ") && !each.includes("[smoke] {"));
  return lines.length === 0 ? "(no `[smoke]` verdict line)" : lines[lines.length - 1].trim();
}

const { command, args, packaged, what } = target();

/*
  THE SHIPPED BUNDLE CANNOT THROW THE SENTENCE THAT SHIPPED.

  A launch that works is the important check and it is below; this one is the
  property, and it is worth asserting separately because a launch can pass by
  luck — the `Dynamic require` shim only throws for the calls esbuild could not
  resolve, so a dependency graph that happens to avoid them today would go green
  and take the hazard with it. `scripts/build.mjs` builds the main process as
  CommonJS precisely so no such shim exists at all. Checked against the built
  file rather than against the build script, because it is the file that ships.

  Only for the dev bundle: the packaged one is inside an asar, and unpacking an
  archive to grep it would be a second, worse version of starting the app.
*/
if (!packaged) {
  const bundle = readFileSync(join(root, "dist/main/index.cjs"), "utf8");
  check(
    "THE BUILT MAIN BUNDLE CONTAINS NO `Dynamic require` SHIM",
    bundle.includes("Dynamic require of") === false,
  );
}

const userDataDir = mkdtempSync(join(tmpdir(), "context-desktop-smoke-"));
console.log(`Starting ${what} in Electron, with its own user data directory.`);

const startedAtMs = Date.now();
let result;
try {
  result = await launch({ command, args, userDataDir });
} finally {
  rmSync(userDataDir, { recursive: true, force: true });
}
const elapsedMs = Date.now() - startedAtMs;
console.log(`It ran for ${elapsedMs}ms and exited ${result.code}.`);

if (result.spawnError) {
  console.log(`FAIL  the app could be started at all — ${result.spawnError}`);
  process.exit(1);
}

// The crash this file exists for is in the output whether or not the process
// then exits non-zero, so it is checked first and by name.
const crash = CRASH_MARKERS.find((marker) => result.output.includes(marker));
check("THE MAIN PROCESS LOADS WITHOUT THROWING", crash === undefined, crash && `the output says "${crash}"`);
check("IT ENDS ON ITS OWN, WITHOUT BEING KILLED", !result.timedOut, `nothing after ${TIMEOUT_MS}ms`);
check("IT EXITS ZERO", result.code === 0, `exit code ${result.code}`);
/*
  The release step's whole contract is "exit 0, on its own, well inside a
  minute", so the bound is checked here rather than trusted. Generous against
  the app's own 30s deadline because this measures process start to process end
  — Gatekeeper's first-launch assessment and Electron's own startup, on a cold
  runner — and the app's timer only begins when its bundle evaluates.
*/
check("IT IS DONE WELL INSIDE THE RELEASE STEP'S BUDGET", elapsedMs < 45_000, `${elapsedMs}ms`);

const report = smokeReport(result.output);
check("IT REPORTS FROM INSIDE A READY APP", report !== null && report.ready === true);

if (report === null) {
  console.log("\nThe app printed no `[smoke]` line. Everything it did print:\n");
  console.log(result.output.trim() || "(nothing)");
  console.log(`\n${failures} FAILURES`);
  process.exit(1);
}

check("IT IS THE BUILD THIS RUN MEANT TO START", report.packaged === packaged, `packaged=${report.packaged}`);
check("A WINDOW EXISTS", report.windows >= 1, `${report.windows} windows`);
check("MACOS GAVE IT A MENU-BAR ITEM", report.trayBounds !== null && typeof report.trayBounds?.width === "number");
/*
  `__dirname`, checked. Building the main process as CommonJS is what removed
  the `require` shim, and the one thing that change touches at runtime is this
  path — `import.meta.dirname` is emptied in a CJS build, which would leave
  every preload pointing at nothing and a window with no bridge on it.
*/
check(
  "IT FOUND ITS OWN RENDERER DIRECTORY",
  report.rendererDirExists === true,
  `rendererDir is ${JSON.stringify(report.rendererDir)}`,
);

// ── DEFECT 2: it has to look like an app somebody can open ────────────────
check("IT HAS A DOCK TILE", report.dock === "visible", `dock is ${report.dock}`);
check(
  "IT HAS AN APPLICATION MENU",
  Array.isArray(report.menuRoles) && report.menuRoles.length > 0,
  `menuRoles is ${JSON.stringify(report.menuRoles)}`,
);
// A page hosting a text editor with no Edit menu has no Cmd-C, Cmd-V or Cmd-Z.
for (const role of ["undo", "redo", "cut", "copy", "paste", "selectall"]) {
  check(`THE EDIT MENU CARRIES ${role.toUpperCase()}`, (report.menuRoles ?? []).includes(role));
}
for (const role of ["close", "quit"]) {
  check(`THE MENU CARRIES ${role.toUpperCase()}`, (report.menuRoles ?? []).includes(role));
}

// ── DEFECT 3: the address a launch actually resolved to ───────────────────
const expected = packaged ? PACKAGED_CONSOLE_URL : DEV_CONSOLE_URL;
check(
  `THE CONSOLE ADDRESS IS ${expected}`,
  report.consoleUrl === expected,
  `it is ${JSON.stringify(report.consoleUrl)}`,
);

// ── DEFECT 4: offline with a mirror on disk must be a pass ────────────────
/*
  THE ONE ROW NO PURE TEST HAS EVER BEEN ABLE TO SEE.

  `--smoke-load` reported `mirrorServed:false` in every case, so an app that
  was offline while a perfectly good mirror served the console exited 1 —
  "no network" wearing "broken app"'s exit code, which is the single confusion
  the mirror exists to answer. **Two fixes shipped for it and both failed on
  hardware while their own tests passed** (#317, #318), and they passed for the
  same reason each time: every check that could see the bug modelled Electron's
  navigation events with an `EventEmitter` a test author wrote, so each fix was
  checked against the sequence its author already believed in. The sequence
  Chromium actually raises had an event in it nobody had modelled — the failed
  live navigation's *own* error document finishing loading, at the dead live
  address, 37ms after the failure and a second and a half before the mirror
  committed. `test/mirror.test.mjs` now models that too, and it only does
  because a real launch printed it.

  So this is the check that would have caught both: a real Electron process, a
  real mirror on disk, a real dead network, reading the real exit code. It is
  the only kind that could have worked, for the same reason this whole file
  exists.

  **How the mirror gets there: an online launch on the same profile, not a
  hand-written manifest.** Writing `mirror/v1/` directly would be faster and
  would need no network — and it would give `MirrorStore`'s on-disk format a
  second author. A change to that format would leave this check green against a
  shape nothing in the app produces any more, which is precisely the failure
  mode that shipped twice: a test agreeing with its author instead of with the
  machine. Seeding it by launching the app online means the mirror under test
  is the one the app really writes, snapshot path and all.

  **Offline is a dead proxy, never the machine's network settings.** Port 9 is
  the discard port: `--proxy-server=127.0.0.1:9` makes every request this app
  makes fail with `ERR_PROXY_CONNECTION_FAILED` and touches nothing outside the
  process. `--user-data-dir` keeps the whole thing in a directory that is
  deleted afterwards.

  **When it cannot run, it says so and does not pass.** No network on this
  machine means no mirror to seed, and there is nothing honest to assert; that
  is a visible `SKIP` line and a count in the summary, never a silent pass. A
  runner with no route to the console is the ordinary case in CI, which is why
  the skip exists at all — but a green run that skipped this row proves less
  than one that ran it, and the output has to admit which it was.
*/
{
  const OFFLINE = "--proxy-server=127.0.0.1:9"; // the discard port: nothing answers.
  const label = "OFFLINE, WITH A MIRROR ON DISK, IT EXITS 0";
  const profile = mkdtempSync(join(tmpdir(), "context-desktop-mirror-"));
  try {
    console.log("\nSeeding a mirror: one online launch on a second throwaway profile.");
    const seed = await launch({ command, args, userDataDir: profile, flags: ["--smoke-load"] });
    const seeded = smokeReport(seed.output);
    const why =
      seeded === null
        ? "the seeding launch printed no `[smoke]` line"
        : seeded.loaded !== true
          ? "the seeding launch never loaded the live console — this machine has no route to it"
          : seeded.snapshotIsHtmlDocument !== true
            ? "the seeding launch loaded but mirrored no text/html index"
            : null;
    if (why !== null) {
      skip(label, `${why}, so there is no mirror to be offline with`);
      skip("...AND REPORTS mirrorServed:true", "same reason");
    } else {
      console.log(`Relaunching on that profile with ${OFFLINE}, so every request fails.`);
      const offline = await launch({
        command,
        args,
        userDataDir: profile,
        flags: ["--smoke-load", OFFLINE],
      });
      const offlineReport = smokeReport(offline.output);
      check(label, offline.code === 0, `exit code ${offline.code}: ${lastSmokeLine(offline.output)}`);
      check(
        "...AND REPORTS mirrorServed:true",
        offlineReport?.mirrorServed === true,
        `the report says ${JSON.stringify({
          loaded: offlineReport?.loaded,
          snapshotIsHtmlDocument: offlineReport?.snapshotIsHtmlDocument,
          mirrorServed: offlineReport?.mirrorServed,
        })}`,
      );
      /*
        `loaded:false` is the half that makes the row mean anything. A pass on
        `loaded:true` would mean the proxy never took hold and the app simply
        went online — the same green, proving the opposite thing.
      */
      check(
        "...on a launch where the live console really did fail",
        offlineReport?.loaded === false,
        `loaded is ${JSON.stringify(offlineReport?.loaded)} — did ${OFFLINE} take effect?`,
      );
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

if (failures) {
  console.log("\nEverything the app printed:\n");
  console.log(result.output.trim() || "(nothing)");
}
const skips = skipped ? ` (${skipped} SKIPPED — see the SKIP lines above)` : "";
console.log(failures ? `\n${failures} FAILURES${skips}` : `\nALL PASS${skips}`);
process.exit(failures ? 1 : 0);
