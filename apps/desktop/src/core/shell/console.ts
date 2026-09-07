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
  NODE_ENV?: string | undefined;
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
 */
export function consoleUrl(env: ConsoleUrlEnv): string {
  const configured = (env.CONTEXT_DESKTOP_UI_URL ?? "").trim();
  const fallback = env.NODE_ENV === "production" ? DEFAULT_CONSOLE_URL : DEV_CONSOLE_URL;
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
