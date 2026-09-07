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

/**
 * The bridge's shape, and the only number the web UI compares against.
 *
 * It moves when the interface changes, never when the app is released — a shell
 * shipped in March and one shipped today both answer `1` if they expose the same
 * surface. What a *particular* build can do is `capabilities()`, asked at
 * runtime, because an unsigned build and a notarised one share this number and
 * differ on whether macOS will give them system audio.
 */
export const BRIDGE_VERSION = 1;

/**
 * What this build can actually do, as the page is allowed to see it.
 *
 * Everything is `false` in this step: the window loads, the probe answers, and
 * nothing is wired. That is the point of shipping it first — a UI that reads
 * capabilities gets honest "no"s from a shell that has not been built yet,
 * which is the same thing it will get from a shell that is simply older.
 */
export interface DesktopCapabilities {
  /** The machine's own audio, via ScreenCaptureKit. Needs a notarised build. */
  systemAudio: boolean;
  /** The microphone, through the shell rather than through `getUserMedia`. */
  mic: boolean;
  /** Meeting detection: this shell watches for a call and says so. */
  detection: boolean;
  /** A menu-bar presence that can start and end a recording with no window. */
  tray: boolean;
  /** A queue in the main process that outlives the page. */
  outbox: boolean;
  /** This machine holds its own revocable grant on the gateway. */
  connection: boolean;
}

export const NO_CAPABILITIES: Readonly<DesktopCapabilities> = Object.freeze({
  systemAudio: false,
  mic: false,
  detection: false,
  tray: false,
  outbox: false,
  connection: false,
});

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
 * so it is not the only layer: `mayAnswerSender` below is what the main process
 * applies to the sender of every console channel, and the two are not one check
 * written twice. **That one decides which renderer is answered — by frame
 * identity, which the page cannot spell — and this one decides which document
 * is trusted.** Either alone leaves a hole, and for ten days after this
 * paragraph was first written the second one existed only in this paragraph.
 */
export function shouldExposeBridge(exposure: BridgeExposure): boolean {
  const { pinned, origin, isTopFrame } = exposure;
  if (!isTopFrame) return false;
  if (pinned === "" || pinned === "null") return false;
  if (origin === "" || origin === "null") return false;
  return origin === pinned;
}

/**
 * What the main process can see about who sent an IPC message.
 *
 * Two facts, both read off `event` in `main/index.ts` and neither of them the
 * renderer's word for anything — which is the difference between this and
 * `shouldExposeBridge`, where `location.origin` is what the document says
 * about itself.
 */
export interface SenderEvidence {
  /** `event.sender === consoleWindow.webContents`. */
  isConsoleWindow: boolean;
  /** `event.senderFrame === event.sender.mainFrame`. */
  isMainFrame: boolean;
}

/**
 * May the main process answer this sender on a console channel?
 *
 * ## This is the half `shouldExposeBridge`'s docblock claimed already existed
 *
 * It said the main process "re-checks the sender on every channel it handles",
 * and that the two together are what keeps a hole from opening. MEASURED when
 * that sentence was read against the tree: `senderFrame` and `event.sender`
 * appeared nowhere in `apps/desktop/src`, and none of the fourteen `ipcMain`
 * handlers looked at who was asking. The layer was prose.
 *
 * Nothing had leaked. Both console channels answer values that are public — the
 * origin is in the window's own URL, the shell info is a name and a version —
 * and every other renderer in this app loads a local file behind a preload that
 * exposes no way to send at all. But a claim that a check exists is read by the
 * next person adding a channel, and the next channels are the ones that
 * docblock calls "the only route from a page to this app's microphone".
 *
 * ## Why identity and not the sender's origin
 *
 * `WebFrameMain.origin` would be the tempting evidence and it is the wrong one
 * *here*: what it reports for a frame the main process is asked about during
 * preload is a lifecycle question no suite in this package can answer, and a
 * guard that refuses the real console on a timing assumption is an outage this
 * app inflicts on itself. Frame identity is unambiguous at every moment.
 *
 * The origin comparison keeps its place in `shouldExposeBridge`, where
 * `location.origin` is the document's own and is exactly what a redirect has to
 * get past: after a redirect off the pin, the preload re-runs in the new
 * document, sees a different origin and exposes nothing — so the main process
 * answering that frame with a public string costs nothing.
 *
 * So the two layers are: **this one decides which renderer is answered, that
 * one decides which document is trusted.** Neither is the other written twice.
 */
export function mayAnswerSender(evidence: SenderEvidence | null | undefined): boolean {
  // Absent evidence is a refusal, not a default. `event.senderFrame` is `null`
  // for a frame that has already gone away, and a missing field must not read
  // as a quiet yes — the same "absence is a refusal" the preload applies to a
  // window that is not there.
  if (!evidence || typeof evidence !== "object") return false;
  return evidence.isConsoleWindow === true && evidence.isMainFrame === true;
}
