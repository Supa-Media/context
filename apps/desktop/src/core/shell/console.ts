/**
 * Which UI this shell hosts, and which origin is allowed to touch it.
 *
 * `docs/decisions/desktop.md` is the argument; this file is the part of it that
 * can be checked without Electron. Two pure functions and one constant:
 *
 *  - `consoleUrl()` decides what the window loads, from the environment.
 *  - `shouldExposeBridge()` decides whether a document gets `window.desktop`.
 *  - `BRIDGE_VERSION` is the contract's shape, not the app's version.
 *
 * Neither function imports Electron, so `test/shell.test.mjs` drives both
 * directly. That matters most for the second one: it is the guard standing
 * between a page we did not serve and the microphone, and a guard that can only
 * be exercised by launching an app is a guard nobody has checked.
 */

/*
  THE BRIDGE'S SHAPE COMES FROM THE PACKAGE, AND IS NOT DECLARED AGAIN HERE.

  `BRIDGE_VERSION`, `DesktopCapabilities` and `NO_CAPABILITIES` were written out
  in this file when `packages/desktop-bridge` did not exist yet (#266 landed
  before #269). They are the shell's half of a contract the web build compares
  against, and two declarations of one contract is the failure
  `core/contract.ts` already names about the meetings protocol: *"a local copy
  of `TranscriptSegment` that drifts by one field is a wire bug that
  typechecks."* A shell answering `version: 1` from its own constant while the
  page checks the package's would be exactly that bug, with a process boundary
  through it.

  Re-exported rather than imported-and-forwarded so that `preload/console.ts`
  and `test/shell.test.mjs` keep importing what they already import: this file
  stays the shell's one door to the contract, and the contract now has one
  author.
*/
export {
  BRIDGE_VERSION,
  NO_CAPABILITIES,
  type DesktopCapabilities,
} from "@context/desktop-bridge";

/** Which UI this shell hosts. Two values, and the second one is on its way out. */
export type DesktopUiMode = "console" | "renderer";

/**
 * The UI a launch hosts, from the environment.
 *
 * **`console` is the default**, which is `docs/decisions/desktop.md`'s step 4:
 * the window hosts `apps/mobile`'s web build, a screen ships with the web
 * deploy, and a change to it reaches a browser, a phone and this Mac at once.
 *
 * `renderer` — the panel and the notepad in `src/renderer/` — stays reachable
 * by setting `CONTEXT_DESKTOP_UI=renderer`, and that escape hatch is the whole
 * reason this step is revertible by one environment variable. Step 5 deletes
 * those windows, and it waits on the confirmations only a Mac can give.
 *
 * **Anything else is the default rather than a refusal.** A misspelt value is
 * not a reason to start an app with no UI at all, and the failure it would
 * cause — a menu-bar app whose window never opens — is far worse than the one
 * it would prevent. `consoleUrl` is the opposite call for the opposite reason:
 * a misspelt *address* is refused, because loading the wrong page is worse than
 * loading none.
 */
export function desktopUiMode(env: { CONTEXT_DESKTOP_UI?: string | undefined }): DesktopUiMode {
  return (env.CONTEXT_DESKTOP_UI ?? "").trim().toLowerCase() === "renderer" ? "renderer" : "console";
}

/** The address the shell hosts when nothing overrides it. */
export const DEFAULT_CONSOLE_URL = "https://context.lc/console";

/** What `expo start` serves, which is what a desktop developer is running. */
export const DEV_CONSOLE_URL = "http://localhost:8081";

/**
 * Loopback, matched on the parsed hostname and never as a substring.
 *
 * The same rule `docs/decisions/meetings.md` states for the transcription
 * Worker's address, for the same reason: `127.0.0.1.attacker.invalid` is an
 * ordinary public name, and a check that reads it as loopback is a check that
 * lets a plaintext origin host the UI that can call `startCapture`.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

export interface ConsoleUrlEnv {
  /** The whole URL, so a self-hoster moves one value rather than three. */
  CONTEXT_DESKTOP_UI_URL?: string | undefined;
}

/**
 * Where the console comes from.
 *
 * `https` always, with loopback the single exception, because `expo start`
 * serves plaintext on `localhost` and developing the desktop shell against the
 * app you are editing is the normal case. Everything else is refused rather
 * than loaded: a shell that will host `http://` from a public host is a shell
 * whose UI can be replaced in transit, and that UI is the thing that asks for
 * the microphone.
 *
 * Throws with a sentence a person can act on. The caller is `main/index.ts` at
 * launch, so a typo in the variable is a refusal at startup rather than a
 * window that quietly loaded somebody else's page.
 *
 * ## `packaged`, and why it is not `NODE_ENV`
 *
 * This used to read `env.NODE_ENV === "production"` to pick the fallback, and
 * **nothing ever sets `NODE_ENV`** — not `scripts/build.mjs`, whose esbuild
 * `define` carries only `__CONTEXT_DESKTOP_SIGNED__`; not
 * `electron-builder.yml`; not `package.json`; not `deploy-desktop.yml`; not
 * Electron; and least of all the launchd environment an app double-clicked from
 * the Dock inherits. So every installed build resolved `http://localhost:8081`,
 * where nothing on a person's Mac is listening, and opened an empty window. The
 * launch crash above it hid that: the app never got far enough to open one.
 *
 * The docblock on `desktopUiMode` already carries the rule, and it was simply
 * not applied to the default — *"a misspelt address is refused, because loading
 * the wrong page is worse than loading none."* A fallback pointing at a dead
 * loopback port is the milder version of exactly that, chosen silently.
 *
 * `app.isPackaged` is the fact that was wanted, and it is **passed in** rather
 * than read here so this stays a pure function with no Electron in it —
 * `core/shell/capabilities.ts` and `core/update/policy.ts` both take the same
 * flag the same way, and both document it as *"false for `electron
 * dist/main/index.cjs` in development."* `CONTEXT_DESKTOP_UI_URL` still beats
 * both, because a self-hoster's own origin is the one answer neither can guess.
 */
export function consoleUrl(env: ConsoleUrlEnv, packaged: boolean): string {
  const configured = (env.CONTEXT_DESKTOP_UI_URL ?? "").trim();
  const fallback = packaged ? DEFAULT_CONSOLE_URL : DEV_CONSOLE_URL;
  const candidate = configured === "" ? fallback : configured;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`CONTEXT_DESKTOP_UI_URL is not a URL: ${candidate}`);
  }
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && isLoopback(url)) return url.toString();
  throw new Error(
    `the console URL must be https (or http on loopback for a local dev server): ${candidate}`,
  );
}

/** The origin the bridge is pinned to, derived from the URL rather than typed twice. */
export function consoleOrigin(url: string): string {
  return new URL(url).origin;
}

export interface BridgeExposure {
  /** The origin the main process pinned this window to. */
  pinned: string;
  /** `location.origin` of the document the preload is running in. */
  origin: string;
  /** `window === window.top`. A preload runs in every frame. */
  isTopFrame: boolean;
}

/**
 * Whether this document gets `window.desktop`.
 *
 * Three refusals, and each one is a different attack:
 *
 *  - **A different origin.** The window is pinned and `will-navigate` is
 *    cancelled, but a redirect chain, a `window.open`, or a future change to
 *    either of those is exactly the kind of thing that ends with a page we did
 *    not serve holding a bridge to a microphone. Compared as whole strings:
 *    a prefix match would give `https://context.lc.attacker.invalid` the bridge.
 *  - **An opaque origin.** `about:blank`, a `data:` document and a sandboxed
 *    frame all report `"null"`, which is a *string* and would compare equal to
 *    another `"null"` if the pin were ever unset. Refused by name.
 *  - **A subframe.** A preload runs in every frame in the window, so an iframe
 *    on the console page is otherwise a fully-privileged bridge belonging to
 *    whoever the page embedded.
 *
 * This function runs in the renderer, and a compromised renderer is the threat,
 * so it is not the only layer: `isBridgeSender` in `main/consoleBridge.ts` is
 * what the main process applies to the sender of every bridge channel that
 * carries a verb, and `isConsoleFrame` — identity and top frame, without the
 * origin — to the two synchronous ones, which the preload calls to learn what
 * the pin *is*. The two layers are not one check written twice. **That one decides which renderer is
 * answered — by frame identity and the sender's own origin, neither of which
 * the page can spell — and this one decides which document is trusted.**
 *
 * Either alone leaves a hole, and for a while the second one existed only in
 * sentences like this one. `#272` found it stated here, specified as guard 3 in
 * `docs/decisions/desktop.md` beside a named test and a sabotage record for
 * that test, and repeated in `packages/desktop-bridge` as the reason its own
 * credential check is allowed to be a name check a Proxy walks past — while
 * `senderFrame` and `event.sender` appeared nowhere in `apps/desktop/src` and
 * none of the seventeen `ipcMain` handlers looked at who was asking. `#277`
 * built it. What this paragraph is now is a pointer to code rather than a
 * description of code that was never written.
 */
export function shouldExposeBridge(exposure: BridgeExposure): boolean {
  const { pinned, origin, isTopFrame } = exposure;
  if (!isTopFrame) return false;
  if (pinned === "" || pinned === "null") return false;
  if (origin === "" || origin === "null") return false;
  return origin === pinned;
}

/**
 * Whether the address a launch actually resolved is the one it should have.
 *
 * `consoleUrl` is a pure function with unit checks, and the defect it exists to
 * prevent was **not in it** — it was in the call site, which asked the question
 * with the wrong argument. So this is asked of the address the window was
 * really pointed at, from inside a running app, by `--smoke`.
 *
 * Two properties, and the first is the load-bearing one because it re-derives
 * nothing:
 *
 *  - **A packaged launch is never pointed at loopback**, unless the operator
 *    set `CONTEXT_DESKTOP_UI_URL` and therefore asked for it. That is F3 stated
 *    as a fact about the world rather than as a second call to the function
 *    being checked, and it is the sentence a release gate needs: an installed
 *    build resolving `http://localhost:8081` is a blank window on a Mac where
 *    nothing is listening. The mirror image — a development launch that quietly
 *    points at production — is refused for the same reason.
 *  - **And the address matches what this launch resolves**, which does catch a
 *    call site passing the wrong flag, because the flag arrives here from
 *    `app.isPackaged` rather than being guessed.
 *
 * Returns `null` when there is nothing wrong, and otherwise the sentence
 * `--smoke` exits non-zero with. A string rather than a boolean so the failure
 * names the address it found, which is the whole diagnostic.
 */
export function unexpectedConsoleAddress(
  env: ConsoleUrlEnv,
  packaged: boolean,
  resolved: string | null,
): string | null {
  if (resolved === null) return "the console window resolved no address at all";

  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return `the console address is not a URL: ${resolved}`;
  }

  const configured = (env.CONTEXT_DESKTOP_UI_URL ?? "").trim() !== "";
  if (!configured && packaged && isLoopback(url))
    return `a packaged launch was pointed at ${resolved}, where nothing on a person's Mac is listening`;
  if (!configured && !packaged && !isLoopback(url))
    return `an unpackaged launch was pointed at ${resolved} rather than the local dev server`;

  let expected: string;
  try {
    expected = consoleUrl(env, packaged);
  } catch (error) {
    return `the console address cannot be resolved a second time: ${(error as Error).message}`;
  }
  return resolved === expected
    ? null
    : `the window was pointed at ${resolved}, but this launch resolves ${expected}`;
}


/* --------------------------- what the console may ask for ----------------- */

/**
 * The permissions the console window is allowed, and it is a list of one.
 *
 * ## The bug this exists because of
 *
 * "Copy note" did nothing. Pressed, clipboard unchanged, and the button did not
 * even claim otherwise — `writeClipboard` answers a boolean and the screen says
 * "Couldn't reach the clipboard on this device", so this was an honest failure
 * that nobody could act on.
 *
 * The cause is one line in `main/windows.ts`. The console hosts a page this app
 * did not write, so its session denies **every** permission request:
 *
 *     setPermissionRequestHandler((_c, _p, callback) => callback(false))
 *
 * That was written about the microphone, and it is right about the microphone.
 * But Chromium routes `navigator.clipboard.writeText` through a
 * `clipboard-sanitized-write` permission request, so denying everything denies
 * the clipboard too — collateral rather than intent. The `execCommand("copy")`
 * fallback in `clipboard.web.ts` is what a page falls back to, and it is
 * deprecated, increasingly refused, and not something the one way a meeting
 * gets off this machine should rest on.
 *
 * ## Why an allowlist rather than deleting the handler
 *
 * Removing it restores Electron's default, which grants most of what a page
 * asks for — including `media`, which is the microphone this app is built so
 * that a compromised page cannot reach. So the handler stays and the deny stays
 * default; exactly one permission is named.
 *
 * `clipboard-sanitized-write` and not `clipboard-read`: writing is what Copy
 * does. Reading the clipboard is a page helping itself to whatever a person
 * last copied, from anywhere, and there is no feature here that needs it.
 * Chromium spells the write permission two ways across versions, so both write
 * spellings are named and neither of them is a read.
 *
 * ## Why it is a pure function in this file
 *
 * `main/windows.ts` imports `electron` and cannot be loaded by the suite at
 * all, so a rule written inline there is a rule nothing checks — and this one
 * is a security boundary with a list in it. Same reason `shouldExposeBridge`
 * and `mayNavigateConsoleWindow` live out here.
 */
export const CONSOLE_PERMISSIONS: readonly string[] = Object.freeze([
  "clipboard-sanitized-write",
  "clipboard-write",
]);

/**
 * Whether the console window may have this permission.
 *
 * Default deny, and an unknown permission is denied by construction: this asks
 * whether a name is on the list rather than whether it is off any list, so a
 * permission Chromium invents next year is refused until somebody adds it here
 * on purpose.
 *
 * @param permission Chromium's own name for it, as Electron passes it through.
 */
export function mayGrantConsolePermission(permission: string): boolean {
  return CONSOLE_PERMISSIONS.includes(permission);
}
