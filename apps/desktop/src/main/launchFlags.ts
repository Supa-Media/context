/**
 * How this launch was started: the command-line flags and the UI it hosts.
 *
 * Read once, at module evaluation, from `process.argv` and `process.env` —
 * moved here from `main/index.ts` verbatim, so the flags and the `--smoke`
 * contract that argues for them stay in one place.
 */

import { app } from "electron";
import { join } from "node:path";
import { desktopUiMode } from "../core/shell/console.ts";

/** `--fake-signals` runs the whole app against the deterministic collectors. */
export const FAKE = process.argv.includes("--fake-signals");
/**
 * `--smoke` starts the app, says what it found, and exits with a verdict.
 *
 * The only test scaffolding in this process, and it is here because the
 * alternative shipped: a build that threw `Dynamic require of "events"` from
 * the first line of the bundle went out signed, notarised and stapled through
 * 922 passing checks, because nothing in this repository had ever *started* it.
 *
 * **The contract the release workflow depends on is the exit code**, so it is
 * stated here rather than left to a harness:
 *
 *  - **0** — the app initialised, a window was created, one `[smoke]` line was
 *    printed, **and every defect this flag exists for was checked**: the
 *    renderer directory resolved, the console window was pointed at the address
 *    this launch should resolve, and the application menu carries the clipboard
 *    and undo roles. Nothing else exits 0.
 *  - **non-zero** — no window was created, the renderer directory is missing,
 *    the console address disagrees with `app.isPackaged`, the application menu
 *    is missing a role, an uncaught exception or rejection reached the top, or
 *    `main()` did not finish inside {@link SMOKE_DEADLINE_MS}.
 *  - **it always ends.** The deadline is armed before `whenReady`, so a hung
 *    launch fails rather than holding a release job open.
 *
 * It needs **no network**. The assertion is that the console window was
 * *created*, not that the page loaded: on a runner nothing answers the console
 * address, the mirror serves its failure page, and a check that waited for a
 * load would be a check that fails on every machine that is not a laptop.
 * Checked rather than assumed, because the rejection handler below would
 * otherwise turn a runner's own dead network into a failed smoke run: pointed
 * at an unresolvable host, `createConsoleWindow`'s `void win.loadURL(url)`
 * produces an Electron *warning* — `Failed to load URL … ERR_NAME_NOT_RESOLVED`
 * — and no unhandled rejection.
 *
 * The one thing it cannot cover is stated rather than papered over: the crash
 * this exists for threw while the module graph was still evaluating, before any
 * line of this file ran, so no handler installed here could have caught it.
 * What Electron does then is print `App threw an error during load`, raise a
 * modal dialog, and wait forever. So the caller must impose its own limit —
 * `test/launch.smoke.mjs` kills the process, and the release step wraps the run
 * in `timeout`. The deadline below covers everything *after* load.
 *
 * A flag on `process.argv` rather than an environment variable, for the same
 * reason `--fake-signals` above is one: it cannot be inherited by accident from
 * whatever launched this, and a packaged `.app` double-clicked from the Dock
 * carries no arguments at all.
 */
export const SMOKE = process.argv.includes("--smoke") || process.argv.includes("--smoke-load");
/**
 * `--smoke-load` is `--smoke` that also waits for the console to really load.
 *
 * Plain `--smoke` deliberately proves *the window was created*, not that the
 * page loaded — that is the whole point of its own docblock, and it is why
 * the release gate can run with no network at all. But that same honesty
 * meant `--smoke`'s report always said `loaded: false`, which is not a lie —
 * it never waited to find out — and it is also not the check that would have
 * caught the console being refused by its own `Cache-Control: private`, which
 * the release gate's offline runner could never have seen either way.
 *
 * So this is a second, opt-in flag for a machine with real network: it waits
 * for the console window's first navigation to settle — loaded or failed,
 * {@link SMOKE_LOAD_DEADLINE_MS} either way — then, if it failed, waits for the
 * mirror's own fallback navigation to settle too, and reports `loaded`,
 * `mirrorServed` and `snapshotIsHtmlDocument`.
 *
 * **The exit code is `loaded || mirrorServed`, not `loaded` alone.** A launch
 * with no network that lands on a good `app://console` mirror is the offline
 * story working as designed, not a degraded pass — and the earlier rule, which
 * failed on `!loaded` before it ever asked about the mirror, could not tell
 * "no network" from "broken app": the exact false positive a mirror exists to
 * answer. `smokeLoadFailure` in `core/shell/mirror.ts` is the one place that
 * rule is stated.
 *
 * **The release gate keeps using plain `--smoke`**: a runner's network is not
 * part of what that gate promises, and a `--smoke-load` run failing because a
 * CI runner has no route to `context.lc` would be exactly the false alarm
 * `SMOKE_DEADLINE_MS`'s own docblock already argues against. This flag is for
 * a person, on a real machine, online and then offline — the two runs
 * `docs/decisions/desktop.md` asks for after a signed build.
 */
export const SMOKE_LOAD = process.argv.includes("--smoke-load");
/** How long `--smoke-load` waits for the console's first navigation to settle. */
export const SMOKE_LOAD_DEADLINE_MS = 30_000;

/**
 * The whole of a `--smoke` run, from module evaluation to the exit code.
 *
 * **Thirty seconds and not ten**, and the widening is the review's, not the
 * author's. The only measurement anyone has is `EXIT=0 ELAPSED_MS=12217` for a
 * packaged launch on an M2 Pro — wall clock from `spawn` to exit, which is
 * Gatekeeper's first-launch assessment plus Electron's own startup plus this
 * app's, with no way to read off how much of it was inside this timer. A budget
 * that a good launch on the fastest hardware in the story finished somewhere
 * inside is a budget a cold CI runner loses, and what that failure looks like
 * is a **red release on a working build** — the one outcome a gate must not
 * produce, because the response to it is to stop trusting the gate.
 *
 * Nothing is weakened by the larger number: the promise is *that a smoke run
 * ends*, which holds at any finite value, and the layer above keeps its own
 * harder kill for the crash this one cannot see — the release step and
 * `test/launch.smoke.mjs` both stop the process themselves at sixty seconds.
 */
export const SMOKE_DEADLINE_MS = 30_000;
/**
 * The deadline actually armed below.
 *
 * A `--smoke-load` run has its own wait — up to {@link SMOKE_LOAD_DEADLINE_MS}
 * for the console to settle, plus whatever `awaitSnapshot()` takes — layered
 * *inside* the ordinary smoke path rather than replacing it. Arming the
 * ordinary {@link SMOKE_DEADLINE_MS} underneath that would end the run with
 * "nothing finished within 30000ms" while `--smoke-load` was still waiting on
 * purpose, which is a false alarm about the same shape `SMOKE_DEADLINE_MS`'s
 * own widening already argues against. So `--smoke-load` gets both budgets,
 * back to back, as one outer limit.
 */
export const EFFECTIVE_SMOKE_DEADLINE_MS = SMOKE_LOAD ? SMOKE_DEADLINE_MS + SMOKE_LOAD_DEADLINE_MS : SMOKE_DEADLINE_MS;

/**
 * Say why, and stop — never `app.quit()`.
 *
 * `quit()` runs `before-quit`, which this app legitimately cancels while a
 * meeting is recording, and a smoke run that can be refused is a smoke run that
 * hangs. `exit()` is unconditional and carries the code, which is the contract.
 *
 * It returns, and every caller must `return` with it. `app.exit()` tears the
 * process down but does **not** stop the frame that called it, and the first
 * version of this function ended in `throw new Error("unreachable")` on that
 * assumption: the throw ran, the handlers below caught it, called back in here,
 * and a passing smoke run exited **7**. The launch check found that within a
 * minute of existing, which is the argument for it in one line.
 */
export function endSmoke(code: number, why: string): void {
  console.log(`[smoke] ${why}`);
  app.exit(code);
}
/**
 * Which UI this shell hosts, and **the default is now the console**.
 *
 * `docs/decisions/desktop.md`'s step 4: the window hosts `apps/mobile`'s web
 * build, so a screen ships with the web deploy and reaches a browser, a phone
 * and this Mac at once. `CONTEXT_DESKTOP_UI=renderer` puts the panel and the
 * notepad back, which is what makes this step revertible by one environment
 * variable — step 5 deletes them, and it waits on a Mac.
 *
 * In console mode the panel and the notepad are **not created at all** rather
 * than created and hidden. Two UIs answering the same meeting is worse than
 * either: a popover asking "take notes?" over a console that is already showing
 * the detection is two consents for one meeting, and whichever is pressed the
 * other is stale. What replaces them is stated where it happens — the tray
 * raises the console window, and the detection reaches the page through the
 * bridge's `onDetection` rather than through a popover.
 */
export const UI_MODE = desktopUiMode(process.env);
export const CONSOLE_UI = UI_MODE === "console";
export const RENDERER_UI = UI_MODE === "renderer";
/**
 * Where the preloads and the renderer's HTML are, relative to the bundle.
 *
 * `__dirname` and not `import.meta.dirname`, because `scripts/build.mjs` builds
 * this entry as **CommonJS** — see the long comment there for why an ESM main
 * process shipped an app that could not start. In a CJS build esbuild warns
 * about `import.meta` and then empties it, which would make every preload path
 * relative to the process's working directory: a window that loads, looks
 * right, and has no bridge on it. `--smoke` reports whether this directory
 * exists so that failure is loud rather than silent.
 */
export const RENDERER_DIR = join(__dirname, "..", "renderer");
