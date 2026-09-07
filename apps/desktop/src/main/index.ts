/**
 * The app: a tray, two windows, a poll loop, and one object that may open a
 * microphone.
 *
 * This file is deliberately the only place where the pieces meet, and it holds
 * no rules of its own. The detector judges (`packages/meetings/src/detect.js`),
 * the gate decides (`core/consent/gate.ts`), the controller records
 * (`core/recording/controller.ts`), the queue sends (`core/sync/*`), and this
 * is the wiring between them. Everything worth arguing about is in a pure
 * function with a check beside it; what is left here is Electron.
 *
 * ## The one behaviour that lives here
 *
 * **Consent is answered against an episode, not against "now".** The panel
 * echoes back the episode it was raised for, and a `accept` for an episode that
 * has already been superseded — the meeting ended while the panel was up — is
 * dropped rather than starting a recording of whatever is happening instead.
 */

import { BrowserWindow, Menu, app, dialog, ipcMain, session } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { createDetectionLoop, loadDetector } from "../core/detection/loop.ts";
import type { DetectionUpdate } from "../core/detection/loop.ts";
import { macosCollectors } from "../platform/macos/index.ts";
import { fixedCollectors } from "../core/detection/collectors.ts";
import {
  IDLE_CONSENT,
  answered,
  asked,
  decideConsent,
  episodeKey,
  forgetEpisode,
} from "../core/consent/gate.ts";
import type { ConsentState } from "../core/consent/gate.ts";
import { isBlockedSource } from "../core/consent/blocklist.ts";
import { MeetingController } from "../core/recording/controller.ts";
import type { BeginResult, SessionView } from "../core/recording/controller.ts";
import { fakeTranscriber } from "../core/capture/transcriber.ts";
import { gatewayTranscriber } from "../core/capture/gatewayTranscriber.ts";
import { PLAN_NOTICES, capturePlan } from "../core/capture/plan.ts";
import { fakeRecorder } from "../core/capture/recorder.ts";
import type { AudioRecorder } from "../core/capture/recorder.ts";
import { DesktopCaptureRecorder } from "./capture.ts";
import { electronPermissionBroker } from "./permissions.ts";
import { DesktopStore } from "./store.ts";
import { emptyOutbox, queueWrite, reconcileDrain } from "../core/sync/outbox.ts";
import type { Outbox } from "../core/sync/outbox.ts";
import { drainOnce } from "../core/sync/drain.ts";
import { memoryTokenStore } from "../core/sync/tokenStore.ts";
import {
  GatewayConnection,
  MEETING_TIER_REFUSAL,
  grantCoversMeetings,
} from "../core/sync/connection.ts";
import { keychainTokenStore } from "./tokenStore.ts";
import { browserlessRefresher, connectMachine, openInSystemBrowser } from "./connect.ts";
import { transcribeChunk } from "./transcribe.ts";
import { ImessageSyncService } from "./imessage.ts";
import { trayPresentation } from "../core/tray/presentation.ts";
import type { TrayState } from "../core/tray/presentation.ts";
import { AppTray } from "./tray.ts";
import { DesktopUpdater } from "./updater.ts";
import {
  createConsoleWindow,
  createNotepad,
  createPanel,
  markQuitting,
  positionPanelUnderTray,
  revealNotepadQuietly,
} from "./windows.ts";
import {
  consoleOrigin,
  consoleUrl,
  desktopUiMode,
  unexpectedConsoleAddress,
} from "../core/shell/console.ts";
import { smokeLoadFailure, wasMirrorServed } from "../core/shell/mirror.ts";
import { darwinMajorFrom, systemAudioCapability } from "../core/shell/capabilities.ts";
import {
  approvalTargetFor,
  createApprovalRoute,
  returnAfterApproval,
} from "../core/shell/approval.ts";
import type { ApprovalTarget } from "../core/shell/approval.ts";
import {
  createApprovalHandover,
  isParkingRedirect,
  parkedRequestFrom,
} from "../core/shell/autoGrant.ts";
import { createConsoleBridge } from "./consoleBridge.ts";
import type { ConsoleBridge } from "./consoleBridge.ts";
import { createConsoleMirror, registerMirrorScheme } from "./consoleMirror.ts";
import type { ConsoleMirror } from "./consoleMirror.ts";
import type {
  CaptureStarted,
  CaptureStateUpdate,
  CaptureSummary,
  DesktopCapabilities,
  MachineApprovalResult,
  MeetingWrite,
  MeetingWriteAck,
  OutboxStatus,
  StartCaptureRequest,
  TrayCommand,
} from "@context/desktop-bridge";
import { CHANNELS, COMMANDS } from "./ipc.ts";
import type { UiState } from "./ipc.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { DesktopSettings } from "../core/settings.ts";

/** `--fake-signals` runs the whole app against the deterministic collectors. */
const FAKE = process.argv.includes("--fake-signals");
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
const SMOKE = process.argv.includes("--smoke") || process.argv.includes("--smoke-load");
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
const SMOKE_LOAD = process.argv.includes("--smoke-load");
/** How long `--smoke-load` waits for the console's first navigation to settle. */
const SMOKE_LOAD_DEADLINE_MS = 30_000;

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
const SMOKE_DEADLINE_MS = 30_000;
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
const EFFECTIVE_SMOKE_DEADLINE_MS = SMOKE_LOAD ? SMOKE_DEADLINE_MS + SMOKE_LOAD_DEADLINE_MS : SMOKE_DEADLINE_MS;

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
function endSmoke(code: number, why: string): void {
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
const UI_MODE = desktopUiMode(process.env);
const CONSOLE_UI = UI_MODE === "console";
const RENDERER_UI = UI_MODE === "renderer";
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
const RENDERER_DIR = join(__dirname, "..", "renderer");
const DRAIN_INTERVAL_MS = 30_000;

let settings: DesktopSettings = DEFAULT_SETTINGS;
let outbox: Outbox = emptyOutbox();
let consent: ConsentState = IDLE_CONSENT;
let lastUpdate: DetectionUpdate | null = null;
let missingPermissions: string[] = [];
/**
 * What the last capture found out about system audio, for the next meeting.
 *
 * `null` until something has tried: there is no API that answers "would macOS
 * give this build the loopback tap" without asking for it, so the probe is the
 * attempt and this is its answer. It is deliberately **not** persisted — a
 * signed build installed over an unsigned one would inherit the old answer and
 * never ask again.
 */
let systemAudioAvailable: boolean | null = null;
let connecting = false;
/**
 * The console window and the bridge behind it, when this launch opened one.
 *
 * Both are `null` on a `CONTEXT_DESKTOP_UI=renderer` launch, which is still the
 * default, and every use of them is optional-chained for that reason rather
 * than guarded by the flag a second time.
 */
let consoleWindow: BrowserWindow | null = null;
let consoleBridge: ConsoleBridge | null = null;
/**
 * The address this launch resolved the console to, once it has.
 *
 * Recorded rather than re-derived, because the bug it exists to expose was in
 * the *wiring* and not in `consoleUrl` itself: a signed build resolved
 * `http://localhost:8081` and showed a blank window, and a check that asks
 * `consoleUrl(process.env, app.isPackaged)` a second time would have agreed
 * with itself and reported nothing. This is what the window was actually
 * pointed at.
 */
let consoleAddress: string | null = null;
/**
 * The offline mirror, and the authority on which origin is pinned.
 *
 * `null` until a console window is opened, and the bridge reads
 * `pinnedOrigin()` through a getter for it — a shell serving the mirror trusts
 * `app://console` *instead of* the live origin, never as well as it.
 */
let consoleMirror: ConsoleMirror | null = null;
/**
 * Resolves once the console window's first navigation has settled — `true` for
 * `did-finish-load`, `false` for a main-frame `did-fail-load` (the mirror or
 * the failure page takes over from there, and this promise does not follow it
 * — that is `consoleMirror.awaitFallback()`'s job, awaited separately by
 * `--smoke-load` once this one resolves `false`).
 *
 * `null` on a launch that never opened a console window at all —
 * `CONTEXT_DESKTOP_UI=renderer`, or a `CONTEXT_DESKTOP_UI_URL` this app
 * refused — which `--smoke-load` reads as "there was nothing to wait for".
 */
let consoleLoadSettled: Promise<boolean> | null = null;

/**
 * The one navigation this window makes that is neither the console nor the
 * mirror: the loopback address a connect in flight is listening on.
 *
 * Module-level and single, because there is one console window and
 * `connectThisMachine` already refuses to run twice over. It is `null` except
 * between pressing Connect and the grant coming back — `core/shell/approval.ts`
 * is the argument, and `test/approval.test.mjs` is the check.
 */
const approval = createApprovalRoute();

/**
 * The parked request this machine has handed to the page, while it holds one.
 *
 * Module-level and single for `approval`'s reason — one console window, one
 * connect at a time. `core/shell/autoGrant.ts` is the argument and
 * `test/autoGrant.test.mjs` is the check.
 */
const handover = createApprovalHandover();

let connectError: string | null = null;

/**
 * Everything this file may put in front of a person that `plan.ts` does not
 * already own, and the whole of it.
 *
 * Read by the bridge's answers *and* — since the panel stopped existing on a
 * default launch — by `explain()`, which is the tray's way of saying why a
 * press did nothing.
 *
 * The same closed-set rule as `PLAN_NOTICES` and the phone's
 * `CAPTURE_MESSAGES`: a sentence assembled from an upstream error is how a
 * channel name or a fragment of a payload ends up on somebody's screen.
 */
const CONSOLE_NOTICES = Object.freeze({
  alreadyRecording: "This machine is already recording a meeting.",
  notTaken: "Your context would not take this meeting from this machine.",
  blocked:
    "You asked this app never to record the app you are in, so it did not start. Change that in the menu bar if you meant to.",
  permissions:
    "macOS has not granted this app the microphone yet, so nothing was recorded. Open System Settings → Privacy & Security → Microphone, enable Context, and record again.",
  /*
    Distinct from `permissions` on purpose: that one means macOS refused the
    request; this one means macOS already granted it and the input still would
    not open. Found on real hardware — the microphone was granted mid-run, but
    the already-running process kept behaving on the answer it saw the first
    time it asked. Telling that person to open System Settings again sends
    them to a toggle that is already on, so the recovery here is the one that
    actually works: quit and relaunch.
  */
  staleMicrophoneGrant:
    "Quit and reopen Context to pick up the microphone permission.",
  captureFailed:
    "The Context app on this machine could not open an input, so this meeting is typed. Your notes still land in your bucket.",
  nothingToOpen:
    "There is nothing for this machine to record, so this meeting is typed. Your notes still land in your bucket.",
  captureDisabled:
    "This machine is not recording meetings yet. Connect it from the menu bar — that dialog is where you say this machine may record, and it is what turns recording on.",
  noConsole:
    "This machine could not open its window, so the menu bar is the whole app for now. Recording still works from here, and anything it records is queued until it can be sent.",
});

/**
 * The application menu, because this is an application.
 *
 * There was none: `Menu.setApplicationMenu` was never called, and a menu-bar-only
 * build did not need one — an accessory app shows no menu bar, so there was
 * nothing to put in it. That stopped being true twice over. The console hosts a
 * *text editor*, and a window with no Edit menu has no Cmd-C, Cmd-V, Cmd-X,
 * Cmd-Z or Cmd-A, because on macOS those are menu key equivalents and nothing
 * else. And a window that Cmd-W cannot close, or that Cmd-Q cannot quit, is not
 * a Mac app.
 *
 * Every item is a `role`, which is deliberate: a role is macOS's own behaviour
 * with macOS's own accelerator and macOS's own localisation, and each one this
 * file spelled out by hand would be a keystroke somebody has to keep working.
 * The *View* menu carries reload and nothing else — a window pinned to one
 * origin has one page to reload, and `toggleDevTools` in a shipped build is a
 * console on somebody's private notes.
 *
 * `close` and not `quit` on Cmd-W is the whole of "closing the window must not
 * end a meeting": `window-all-closed` below refuses to quit, the tray stays,
 * and a recording in progress runs on in this process with no window at all.
 */
function installApplicationMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.getName(),
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      { label: "View", submenu: [{ role: "reload" }, { type: "separator" }, { role: "togglefullscreen" }] },
      {
        label: "Window",
        submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "close" }],
      },
    ]),
  );
}

async function main(): Promise<void> {
  /*
    A Dock tile, an app-switcher entry and a menu bar — and the tray as well.

    This app hid from the Dock (`app.dock.hide()` here, `LSUIElement: true` in
    `electron-builder.yml`) because it began as a menu-bar app with no window of
    its own. Step 4 ended that: *"the console is what a launch opens"*, and a
    windowed application with no Dock tile and no app-switcher entry is one the
    person who installed it cannot find. The owner's words, holding the first
    signed build: **"I dont even see a launched app, I should be able to open
    the app locally like all these other apps."**

    Nothing about the menu bar changes — the tray is still built below, still
    records with no window open, and is still the whole app on a launch whose
    window could not be built. This is a Dock tile *as well as*, never instead
    of. `docs/decisions/desktop.md`, "The app is in the Dock", is the argument.

    **And it is conditional on the UI this launch hosts, not unconditional.**
    `CONTEXT_DESKTOP_UI=renderer` is still the panel and the notepad — a popover
    under the menu-bar icon, with no window a person opens — and that really is
    an accessory app. It keeps `app.dock.hide()` and gets no application menu,
    because macOS shows an accessory app's menu bar to nobody. The one escape
    hatch step 5 is waiting to remove goes on behaving exactly as it did.
  */
  if (RENDERER_UI) app.dock?.hide();
  else installApplicationMenu();

  const store = new DesktopStore(app.getPath("userData"));
  settings = await store.readSettings();
  outbox = await store.readOutbox();

  /*
    The credential, and the one place it lives.

    `--fake-signals` gets a memory store so a development run cannot write a
    keychain entry, and the real one is `safeStorage` over a 0600 file in
    `userData`. Either way the renderer never sees it: `preload` exposes no
    channel that reads a token, and every request that carries one is made
    here.
  */
  const tokens = FAKE ? memoryTokenStore(null) : keychainTokenStore(app.getPath("userData"));
  const connection = new GatewayConnection({ store: tokens, refresh: browserlessRefresher() });
  await connection.load();
  const imessage = new ImessageSyncService({
    store,
    connection,
    settings: () => settings,
    onChange: (status) => {
      consoleBridge?.emitImessage(status);
      push();
    },
  });
  imessage.reconfigure();
  // `null` in console mode. Every use below is guarded rather than the flag
  // being read a second time — see `UI_MODE`.
  const panel = RENDERER_UI ? createPanel(RENDERER_DIR) : null;
  const notepad = RENDERER_UI ? createNotepad(RENDERER_DIR) : null;

  const capture = FAKE ? null : new DesktopCaptureRecorder(RENDERER_DIR);
  const recorder: AudioRecorder = capture ?? fakeRecorder();
  const controller = new MeetingController({
    recorder,
    /*
      One engine, held for the life of the app, and `capturePlan` decides
      whether it is used.

      Not a branch on `settings.transcription`, which is what this was first
      written as: that setting changes at runtime — connecting a machine is
      where a person chooses cloud transcription — and a transcriber chosen at
      launch would go on being the wrong one until the next restart, silently.
      The plan is re-asked at the start of every meeting instead, and it answers
      "typed meeting" for both states where nothing can transcribe: no grant on
      this machine, and on-device chosen with no on-device engine built.

      `--fake-signals` still swaps it, so the notepad can be worked on without a
      meeting and without a network.
    */
    transcriber: FAKE
      ? fakeTranscriber(["...", "..."])
      : gatewayTranscriber({ send: (request) => transcribeChunk(connection, request) }),
    permissions: electronPermissionBroker(),
    device: { platform: "macos", name: app.getName(), appVersion: app.getVersion() },
    outbox: () => outbox,
    setOutbox: (next) => {
      outbox = next;
      void store.writeOutbox(next);
    },
    now: () => new Date(),
    onChange: () => push(),
    /*
      Every finished segment, once, as it is produced.

      The console needs the *event* and not the state: `onChange` carries the
      whole transcript on every keystroke as well, and a page that diffed two
      arrays to find the new words would be a second implementation of what the
      controller already knows. `capture/desktop.ts` on the other side takes
      these straight into the app's own recorder interface.
    */
    onSegment: (segment) => consoleBridge?.emitSegment(segment),
  });

  /*
    `__CONTEXT_DESKTOP_SIGNED__` is a build-time literal, not a live read of
    `process.env` — see `scripts/build.mjs`'s header and `env.d.ts`. A dev
    launch (`--fake-signals` or not) is always `false` here because nothing
    outside `deploy-desktop.yml` ever sets `CONTEXT_DESKTOP_SIGNED`, and an
    unpackaged launch is refused by `shouldArmUpdater` regardless.
  */
  const updater = new DesktopUpdater({
    packaged: app.isPackaged,
    signed: __CONTEXT_DESKTOP_SIGNED__,
    capturing: () => controller.recording,
    onStateChange: () => push(),
    log: (message) => console.log(message),
  });

  const detector = await loadDetector();
  const loop = createDetectionLoop({
    collectors: FAKE ? fixedCollectors({ processes: ["zoom.us"], microphoneInUse: true }) : macosCollectors(),
    detector,
    blocklist: () => settings.blocklist,
    enabled: () => settings.detectionEnabled,
    onUpdate: (update) => {
      lastUpdate = update;
      void onDetection(update);
    },
  });

  /**
   * Raise the panel under the menu-bar icon, and never with focus.
   *
   * `showInactive` throughout: this panel appears *during a meeting*, and a
   * window that takes focus while somebody is talking is a window they close
   * by quitting the app.
   */
  function showPanel(): void {
    if (panel === null || panel.isDestroyed()) return;
    positionPanelUnderTray(panel, tray.bounds());
    panel.showInactive();
  }

  /**
   * Bring the console window forward, which is what the tray points at now.
   *
   * `show()` rather than `showInactive()`: unlike the panel, this is not a
   * popover that appears *during* a meeting on its own — it opens because
   * somebody clicked the menu bar, and a window that answers a click by
   * appearing behind what they were doing reads as a window that did not open.
   *
   * A window that is *gone* is `openConsoleWindow`'s business, not this
   * function's: the panel is hidden when somebody dismisses it, while the
   * console window is destroyed, and which of "raise it" and "build it again"
   * a caller means is exactly what the two names carry.
   *
   * Answers whether there is a window now, so a caller can say why there is not
   * rather than doing nothing at all.
   */
  function showConsoleWindow(): boolean {
    if (consoleWindow === null || consoleWindow.isDestroyed()) return false;
    consoleWindow.show();
    consoleWindow.focus();
    return true;
  }

  /**
   * The window a menu-bar click asks for, built again if it is gone.
   *
   * Separate from `showConsoleWindow` because the two callers want different
   * things: `explain()` raises a window that already exists behind a sentence
   * and must not conjure one for a refusal, while the menu-bar click *is* the
   * request for the window and has nowhere else to go.
   */
  function openConsoleWindow(): boolean {
    if (consoleWindow === null || consoleWindow.isDestroyed()) openConsoleWindowIfAsked();
    return showConsoleWindow();
  }

  /**
   * Say why a press did nothing.
   *
   * The panel used to be the whole answer — it renders the state and the reason
   * with it — and on a default launch there is no panel. "The button did
   * nothing" is the worst outcome available here, and the console has no
   * channel for a sentence that is not attached to a capture, so the tray's
   * refusals are said in a message box with the window raised behind them.
   *
   * Every sentence comes from `CONSOLE_NOTICES` or `PLAN_NOTICES`; none is
   * assembled here, for the reason those sets exist.
   */
  function explain(sentence: string): void {
    if (panel !== null) {
      showPanel();
      return;
    }
    showConsoleWindow();
    void dialog.showMessageBox({
      type: "info",
      title: "Context",
      message: sentence,
      buttons: ["OK"],
    });
  }

  const tray = new AppTray({
    togglePanel: (bounds) => {
      /*
        No panel means the console is the window this app has, so the menu-bar
        click raises that — and says why when there is none to raise, which is
        the only way this launch can have no UI: `consoleUrl` refused the
        address it was given, and that was logged where nobody is looking.
      */
      if (panel === null) {
        if (!openConsoleWindow()) explain(CONSOLE_NOTICES.noConsole);
        return;
      }
      if (panel.isVisible()) {
        panel.hide();
        return;
      }
      positionPanelUnderTray(panel, bounds);
      panel.showInactive();
    },
    openNotepad: () => {
      if (notepad !== null) {
        revealNotepadQuietly(notepad);
        return;
      }
      if (!openConsoleWindow()) explain(CONSOLE_NOTICES.noConsole);
    },
    record: () => void pressed("record", () => recordNow()),
    end: () => void pressed("end", () => endMeeting()),
    connect: () => void connectThisMachine(),
    disconnect: () => void disconnectThisMachine(),
    toggleDetection: () => void update({ detectionEnabled: !settings.detectionEnabled }),
    toggleImessage: () => void update({ imessageEnabled: !settings.imessageEnabled }),
    installUpdate: () => {
      // A stray click cannot install mid-meeting: `install()` re-checks
      // `controller.recording` itself, regardless of what this menu currently
      // shows — see `DesktopUpdater.install()` and `mayInstall()`.
      if (!updater.install()) push();
    },
    quit: () => app.quit(),
  });

  /**
   * A verb somebody pressed in the shell's own UI, done and announced.
   *
   * The tray is a complete capture surface on its own — a person can record a
   * whole meeting with the console never having loaded — so these are not the
   * page's only route to these verbs. They are told to the page so that a
   * console that *is* open agrees with the menu bar instead of drawing a stale
   * Record button, which is the whole of what `onTrayCommand` is for.
   *
   * Announced *before* the work rather than after it: `end()` awaits a drain,
   * and a page that learned about the press only once the queue had emptied
   * would show the old state for as long as the network took.
   */
  function pressed(command: TrayCommand, run: () => Promise<unknown>): Promise<unknown> {
    consoleBridge?.emitTrayCommand(command);
    return run();
  }

  function trayState(): TrayState {
    const view = controller.view();
    if (view?.state === "finalizing") return "finalizing";
    if (view?.state === "recording" || view?.state === "paused") return "recording";
    if (lastUpdate?.state.active) return "detected";
    return settings.detectionEnabled ? "armed" : "idle";
  }

  function uiState(): UiState {
    const view = controller.view();
    const presentation = trayPresentation({
      state: trayState(),
      elapsedMs: controller.elapsedMs(),
      title: view?.title ?? lastUpdate?.result.suggestedTitle ?? null,
      pending: new Set(outbox.entries.map((entry) => entry.sessionId)).size,
      degraded: lastUpdate?.degraded ?? [],
    });
    return {
      tray: {
        state: presentation.state,
        title: presentation.title,
        tooltip: presentation.tooltip,
        indicator: presentation.indicator,
      },
      detection:
        lastUpdate && lastUpdate.state.active
          ? {
              active: true,
              episode: episodeKey(lastUpdate.state),
              suggestedTitle: lastUpdate.result.suggestedTitle,
              sourceLabel: lastUpdate.state.source?.app ?? lastUpdate.state.source?.kind ?? "a meeting",
              summary: lastUpdate.summary,
              evidence: lastUpdate.evidence,
              degradedNotice: lastUpdate.degradedNotice,
              attendees: lastUpdate.result.suggestedAttendees.length,
            }
          : null,
      session: view
        ? {
            id: view.id,
            title: view.title,
            state: view.state,
            elapsedMs: controller.elapsedMs(),
            notes: view.notes,
            transcript: view.transcript.map((segment) => ({
              id: segment.id,
              startMs: segment.startMs,
              text: segment.text,
              speaker: segment.speaker,
              channel: segment.channel,
            })),
            transcriptionLabel: view.transcriptionLabel,
            audioLeavesDevice: view.audioLeavesDevice,
            capturing: view.capturing,
            audio: view.audio,
            notice: view.notice,
          }
        : null,
      settings: {
        askBeforeEveryMeeting: settings.askBeforeEveryMeeting,
        blocklist: settings.blocklist,
        captureEnabled: settings.captureEnabled,
        detectionEnabled: settings.detectionEnabled,
      },
      connection: {
        state: connection.state(),
        gateway: connection.baseUrl(),
        // Said out loud rather than hidden: a machine with no encrypted storage
        // holds its credential for this launch only, and a person who sees the
        // app ask to be connected after every restart is owed the reason.
        encrypted: tokens.encrypted,
        connecting,
        /*
          The last attempt's failure, or the standing one: a machine connected
          at the narrower tier is a machine holding its meetings, and the reason
          has to be readable *whenever* that is true rather than only in the
          seconds after the connect that caused it. So it is derived from the
          grant on every push rather than latched into `connectError` once —
          a restart, a refresh, or a grant that predates the tier existing all
          reach this line and all say the same thing. `connectError` still wins
          when there is one: it is newer and more specific.
        */
        error:
          connectError ??
          (connection.state() === "connected" && !grantCoversMeetings(connection.scope())
            ? MEETING_TIER_REFUSAL
            : null),
      },
      pending: new Set(outbox.entries.map((entry) => entry.sessionId)).size,
      missingPermissions,
    };
  }

  function push(): void {
    const state = uiState();
    tray.setMenuState({
      recording: controller.recording,
      detectionEnabled: settings.detectionEnabled,
      imessageEnabled: settings.imessageEnabled,
      connected: state.connection.state === "connected",
      updateReady: updater.state === "ready",
    });
    tray.render(
      trayPresentation({
        state: trayState(),
        elapsedMs: controller.elapsedMs(),
        title: state.session?.title ?? state.detection?.suggestedTitle ?? null,
        pending: state.pending,
        degraded: lastUpdate?.degraded ?? [],
      }),
    );
    for (const window of [panel, notepad]) {
      if (window !== null && !window.isDestroyed()) window.webContents.send(CHANNELS.state, state);
    }
    /*
      The same change, in the vocabulary the contract uses.

      Four narrow views rather than the whole `UiState`, and that is not an
      optimisation: `UiState` is this app's internal shape and the console is a
      *remote origin*. Sending it whole would mean every field ever added to
      the panel's state is also published to whatever `CONTEXT_DESKTOP_UI_URL`
      points at, which is precisely the accident the bridge exists to make
      impossible.
    */
    consoleBridge?.push({
      captureState: captureStateUpdate(),
      connection: { ...state.connection },
      outbox: outboxStatus(),
      detection: state.detection,
    });
  }

  async function update(patch: Partial<DesktopSettings>): Promise<void> {
    settings = { ...settings, ...patch };
    await store.writeSettings(settings);
    if ("imessageEnabled" in patch) imessage.reconfigure();
    push();
  }

  async function onDetection(current: DetectionUpdate): Promise<void> {
    if (current.transition === "cleared") {
      consent = forgetEpisode(consent, consent.episode);
      if (panel !== null && !panel.isDestroyed()) panel.hide();
      push();
      return;
    }

    const action = decideConsent({
      detector: current.state,
      consent,
      settings,
      recording: controller.recording,
    });

    if (action.kind === "ask") {
      consent = asked(action.episode);
      showPanel();
    } else if (action.kind === "start") {
      await beginMeeting(action.episode);
    }
    push();
  }

  /**
   * Start one meeting, however the yes arrived.
   *
   * `episode` is the consent, and it has exactly two sources: the panel
   * answering a detected meeting, or a person pressing Record. Both are the
   * same sentence — "record the meeting I am in" — so both come through here
   * rather than through two paths that could drift on what capture means.
   */
  async function beginMeeting(
    episode: string,
    manual = false,
    id?: string,
    queueWrites = true,
  ): Promise<BeginResult | null> {
    const detected = manual ? null : lastUpdate;
    if (!manual && !detected) return null;
    // What this machine can actually do right now, in one place. `plan.notice`
    // is the sentence the panel shows when it is less than everything.
    const plan = capturePlan({
      settings,
      connected: connection.state() === "connected",
      systemAudio: systemAudioAvailable,
    });

    const result = await controller.begin({
      id,
      queueWrites,
      source: detected?.state.source ?? detected?.result.source ?? { kind: "unknown" },
      title: detected?.result.suggestedTitle ?? "Untitled meeting",
      attendees: detected?.result.suggestedAttendees ?? [],
      grantedEpisode: episode,
      channels: plan.channels,
      notice: plan.notice,
    });

    if (result.ok) {
      missingPermissions = [];
      /*
        The probe's answer, recorded for the next meeting.

        The renderer is the only thing that can know whether macOS handed over a
        system-audio track, and it only knows by asking. So the first meeting on
        an unsigned build asks and degrades; every meeting after it plans for
        the microphone alone and does not raise Screen Recording again.
      */
      if (capture && plan.channels.includes("system")) {
        systemAudioAvailable = !capture.degradedChannels().includes("system");
        if (!systemAudioAvailable) {
          // Re-planned rather than re-worded, so the sentence a person sees is
          // the one `plan.ts` owns and the suite checks.
          controller.notice(capturePlan({ settings, connected: true, systemAudio: false }).notice);
        }
      }
      if (panel !== null && !panel.isDestroyed()) panel.hide();
      // In console mode the page is already open and already recording; there
      // is nothing to reveal and nothing to steal focus for.
      if (notepad !== null) revealNotepadQuietly(notepad);
    } else if (result.why === "permissions") {
      // Something explains, rather than the app silently doing nothing: the
      // panel where there is one, a message box where there is not.
      missingPermissions = [...(result.missing ?? [])];
      explain(CONSOLE_NOTICES.permissions);
    } else if (result.why === "stale-permission") {
      // Granted, per macOS — the input just would not open in this already-
      // running process. Sending this person to System Settings again would
      // point at a toggle that is already on.
      missingPermissions = [];
      explain(CONSOLE_NOTICES.staleMicrophoneGrant);
    }
    push();
    return result;
  }

  /**
   * "Record a meeting", from the tray or the panel.
   *
   * The episode is minted here because there is no detector episode to answer:
   * a person pressing Record is consenting to the meeting in front of them, and
   * the gate's rules about *asking* do not apply to somebody who has asked us.
   *
   * **The blocklist is checked, and what it can see here is less than it can
   * see on the detected path — which is worth stating rather than implying.**
   * Blocked apps are stripped out of the signals *before* `detect()` sees them,
   * by design, so a blocked app never becomes a source; the check below can
   * therefore only refuse a source the detector is currently reporting. Press
   * Record during a call in a blocked app and the recording starts, because
   * nothing in this process can see that app without undoing the rule that it
   * is never observed. That is the honest shape of the trade: the blocklist
   * means "never record this app *for me*, automatically", and it cannot also
   * mean "refuse an instruction I gave with the app in front of me" without
   * watching the app it promised not to watch.
   */
  async function recordNow(): Promise<void> {
    if (controller.recording) return;
    /*
      The master switch still wins, and it is the reason this is not a silent
      no-op.

      `captureEnabled` is "this machine may open a microphone at all" — a hard
      stop that no detection and no button talks past — and it is off on a fresh
      install by design. What it lacked was any way to become true: nothing in
      the app set it, so a person could press Record forever and get nothing.
      Connecting a machine turns it on, because that dialog is where somebody
      says this machine records their meetings; until then the panel says so
      rather than the press doing nothing.
    */
    if (!settings.captureEnabled) {
      explain(CONSOLE_NOTICES.captureDisabled);
      return;
    }
    const source = lastUpdate?.state.source ?? null;
    if (source && isBlockedSource(source, settings.blocklist)) {
      explain(CONSOLE_NOTICES.blocked);
      return;
    }
    const episode = `manual:${Date.now()}`;
    consent = answered(episode, "granted");
    await beginMeeting(episode, true);
  }

  async function endMeeting(): Promise<SessionView | null> {
    if (!controller.recording) return null;
    const finished = await controller.end();
    push();
    await drain();
    controller.clear();
    // The note is written; an update the download event deferred may now
    // offer itself. See `docs/decisions/desktop.md`'s "never during a
    // meeting" and `core/update/policy.ts`'s `deferred-for-recording` state.
    updater.captureEnded();

    /*
      The detector is very likely still active — ending the recording does not
      close Zoom — so the episode is marked answered rather than forgotten. A
      `loop.reset()` here would clear the hysteresis, re-activate two polls
      later, and put the panel back up asking to record the meeting the person
      just ended. "Declined" is exactly the right word for it: they have
      decided about this meeting, and the decision holds until `since` changes,
      which is a genuinely different meeting.
    */
    const episode = lastUpdate ? episodeKey(lastUpdate.state) : null;
    consent = episode === null ? IDLE_CONSENT : answered(episode, "declined");
    push();
    return finished;
  }

  /**
   * Where each finished meeting's note landed, as the queue learns it.
   *
   * The console is what needs this: its page hands the shell a finalize and
   * must not draw the meeting as saved until the note is in the bucket, so
   * "the gateway answered with this path" is the one fact it is waiting for.
   * The tray path has no use for it and does not read it.
   *
   * Kept in memory only. It is a receipt for a call this process made, not a
   * record of anything — the note itself is in the customer's bucket, and a
   * relaunch that had forgotten a path re-finalizes and is answered with the
   * same one.
   */
  const notePaths = new Map<string, string>();

  /**
   * The drain in flight, so there is never more than one.
   *
   * Two overlapping drains post the same head entry twice and then race to
   * assign the queue, and there are two callers now: the fifteen-second timer
   * and every finalize the console hands over. Chained rather than skipped —
   * a finalize that joined a drain which started *before* its entry was queued
   * would be told "queued" about a request nobody made, which is the one answer
   * this path may not give.
   */
  let draining: Promise<void> = Promise.resolve();

  function drain(): Promise<void> {
    draining = draining.then(drainNow, drainNow);
    return draining;
  }

  async function drainNow(): Promise<void> {
    /*
      The base URL is the connection's, not the settings file's.

      Both existed, and settings never had one: `gatewayBaseUrl` defaulted to
      null with nothing on the machine able to set it, so this returned on its
      first line and the queue never drained at all. It is one value now, minted
      by the OAuth flow beside the credential it belongs to — which also means a
      token cannot be posted to a gateway other than the one it was minted for,
      because the two are read from the same record.
    */
    const baseUrl = connection.baseUrl();
    if (baseUrl === null) return;
    /*
      The queue does not stand still for the round trip.

      A segment is spoken, somebody types, the console hands over a write — all
      of them synchronous, all of them landing on `outbox` while this awaits.
      Assigning `report.outbox` over the top drops every one of them, and the
      dropped write has already been answered as accepted. So the outcome is
      re-applied to the queue as it is *now*. See `reconcileDrain`.
    */
    const before = outbox;
    const report = await drainOnce(
      before,
      {
        baseUrl,
        token: () => connection.token(),
        // Not the scope this app asked for: the one the grant came back with.
        // `postEntry` holds a meeting rather than let the gateway file it at a
        // visibility the person did not choose. See `grantCoversMeetings`.
        scope: () => connection.scope(),
      },
      () => Date.now(),
    );
    outbox = reconcileDrain(before, report.outbox, outbox);
    for (const landed of report.written) notePaths.set(landed.sessionId, landed.notePath);
    await store.writeOutbox(outbox);
    push();
  }

  /* --- the console window, and the bridge behind it ---------------------- */

  /**
   * What THIS build can actually do, asked rather than declared.
   *
   * `mic` is "there is a real recorder in this process", which `--fake-signals`
   * makes false: a development run that answered `true` would put a Record
   * button on the console over a recorder that produces scripted text, and the
   * app would be claiming a capability it does not have — the one thing
   * `docs/decisions/meetings.md` forbids by name.
   *
   * `connection` is *this machine holds a grant*, not "this shell has a
   * connection feature", which is what the contract's own comment says it is.
   * A machine with no grant has nowhere to transcribe and nowhere to send a
   * meeting, and that is a fact about now rather than about the build.
   */
  function shellCapabilities(): DesktopCapabilities {
    const canCapture = capture !== null;
    return {
      systemAudio:
        canCapture &&
        systemAudioCapability({
          platform: process.platform,
          packaged: app.isPackaged,
          // The same build-time literal the updater reads, and asked for the
          // same reason: macOS gives a loopback tap to a signed, notarised app,
          // and a locally packaged unsigned build is neither.
          signed: __CONTEXT_DESKTOP_SIGNED__,
          darwinMajor: darwinMajorFrom(release()),
          probed: systemAudioAvailable,
        }),
      mic: canCapture,
      detection: true,
      tray: true,
      outbox: true,
      connection: connection.state() === "connected",
    };
  }

  /** The recorder's four words, from the controller's own state machine. */
  function captureStateUpdate(): CaptureStateUpdate {
    const view = controller.view();
    if (view === null) return { state: "idle", capturing: false, fault: null };
    const state =
      view.state === "recording" || view.state === "paused"
        ? view.state
        : view.state === "idle"
          ? "idle"
          : "stopped";
    return {
      state,
      capturing: view.capturing,
      fault:
        view.state === "failed"
          ? { recoverable: false, message: view.failureReason ?? CONSOLE_NOTICES.captureFailed }
          : null,
    };
  }

  /** Counts, never contents. What the queue is holding right now. */
  function outboxStatus(): OutboxStatus {
    const pending = outbox.entries.filter((entry) => entry.state === "pending");
    const parked = outbox.entries.filter((entry) => entry.state === "parked");
    return {
      pending: pending.length,
      parked: parked.length,
      // The queue's own words about the last refusal, which `outbox.ts` already
      // keeps closed to the contract's codes and the gateway's short message.
      lastError: parked[0]?.parked?.message ?? pending.find((e) => e.lastError)?.lastError ?? null,
    };
  }

  /**
   * "Record this meeting", asked by the page.
   *
   * The same sentence as the tray's Record and the panel's Take notes, and it
   * lands on the same three refusals in the same order — the master switch, the
   * blocklist, the consent gate — because a page that could talk past any of
   * them would be the reason not to host a page at all. What it adds is the
   * **id**: the meeting is already named by the app that asked, and the shell
   * records under that name so one meeting is one note.
   *
   * A refusal throws a sentence rather than a code. `createConsoleBridge` turns
   * it into `{ ok: false, message }` and the preload rethrows exactly that
   * string, which `capture/desktop.ts` shows: *"the shell's own sentence when
   * it gave one"*.
   */
  async function startFromConsole(request: StartCaptureRequest): Promise<CaptureStarted> {
    if (controller.recording) throw new Error(CONSOLE_NOTICES.alreadyRecording);
    if (!settings.captureEnabled) throw new Error(PLAN_NOTICES.notConnected);

    const source = lastUpdate?.state.source ?? null;
    if (source && isBlockedSource(source, settings.blocklist)) {
      throw new Error(CONSOLE_NOTICES.blocked);
    }

    /*
      The plan is asked before anything begins, and a notes-only plan is a
      refusal rather than a recording of nothing.

      `capturePlan` answers "no channels" for the two states where nothing can
      transcribe — no grant, or on-device chosen with no on-device engine — and
      beginning a meeting there would leave the shell holding a session the page
      also holds, for a recording that was never going to exist. Refusing hands
      the page the plan's own sentence instead, and the page's meeting carries
      on as a typed one, which is what it already does in a browser.
    */
    const plan = capturePlan({
      settings,
      connected: connection.state() === "connected",
      systemAudio: systemAudioAvailable,
    });
    const wanted = plan.channels.filter((channel) =>
      channel === "mic" ? request.mic : request.systemAudio,
    );
    if (wanted.length === 0) throw new Error(plan.notice ?? CONSOLE_NOTICES.nothingToOpen);

    const episode = `console:${Date.now()}`;
    consent = answered(episode, "granted");
    const result = await beginMeeting(episode, true, request.sessionId, false);
    if (result === null || !result.ok) {
      throw new Error(
        result?.why === "permissions"
          ? CONSOLE_NOTICES.permissions
          : result?.why === "stale-permission"
            ? CONSOLE_NOTICES.staleMicrophoneGrant
            : CONSOLE_NOTICES.captureFailed,
      );
    }

    const degraded = capture?.degradedChannels() ?? [];
    const opened = wanted.filter((channel) => !degraded.includes(channel));
    return {
      sessionId: result.view.id,
      mic: opened.includes("mic"),
      systemAudio: opened.includes("system"),
      startedAtMs: Date.parse(result.view.startedAt),
      transcribesAt: plan.transcription === "cloud" ? "cloud" : "nowhere",
      // The controller's own notice, which `beginMeeting` has already re-planned
      // if the system tap was refused. One sentence, owned by `plan.ts`.
      notice: controller.view()?.notice ?? null,
    };
  }

  /**
   * One write about a meeting, from the page, into this machine's queue.
   *
   * `docs/decisions/desktop.md`: **one meeting is one credential, and on the
   * desktop it is the machine's grant.** The page composes — it holds the
   * record, the human's notes and the destination — and this queues, addresses
   * and sends with the credential in `safeStorage`, through the same outbox the
   * tray-only recording uses. So a meeting recorded with the window closed and
   * one recorded from the console take the same path, and the queue that
   * outlives the window is on both.
   *
   * ## Three answers, and the finalize is the one that is not an ack
   *
   *  - **Parked** — the gateway refused this meeting in a way retrying cannot
   *    fix. Answered on *every* kind rather than only on the finalize, because
   *    a parked head blocks its own session: the page has to learn about it at
   *    the next write it makes rather than waiting for a finalize that will
   *    never be attempted.
   *  - **Written** — a finalize whose note reached the bucket, with the path
   *    the gateway chose.
   *  - **Queued** — this machine holds it. For the first three kinds that is a
   *    completed handover. For a **finalize** it deliberately is not: the note
   *    is not written, and `docs/decisions/app-and-console.md` is unambiguous
   *    that a UI may never claim a write it has not seen land. The page keeps
   *    the meeting and asks again, which is idempotent — a second finalize of a
   *    complete session is answered with the note that already exists.
   */
  async function writeMeetingFromConsole(write: MeetingWrite): Promise<MeetingWriteAck> {
    outbox = queueWrite(outbox, {
      sessionId: write.sessionId,
      kind: write.kind,
      body: write.body,
      context: write.context,
      now: Date.now(),
    });
    await store.writeOutbox(outbox);
    push();

    /*
      A finalize drains now; the other three wait for the timer.

      Not an optimisation in either direction. Draining on every `segments`
      write would be a request per twenty seconds of audio against somebody's
      own gateway, and the queue's whole design is that a meeting is sent in one
      pass. Draining on the finalize is what turns "queued" into a note path
      while the person is still looking at the screen that ended the meeting.
    */
    if (write.kind === "finalize") await drain();

    const parked = outbox.entries.find(
      (entry) => entry.sessionId === write.sessionId && entry.state === "parked",
    );
    if (parked) {
      return {
        sessionId: write.sessionId,
        queued: false,
        notePath: null,
        rejected: {
          code: parked.parked?.code ?? "meeting_invalid",
          message: parked.parked?.message ?? CONSOLE_NOTICES.notTaken,
        },
      };
    }

    const notePath = notePaths.get(write.sessionId) ?? null;
    return {
      sessionId: write.sessionId,
      queued: outbox.entries.some((entry) => entry.sessionId === write.sessionId),
      notePath,
      rejected: null,
    };
  }

  /** The last capture's shape, so `stopCapture` is safe to call twice. */
  let lastCaptureSummary: CaptureSummary = {
    sessionId: "",
    endedAtMs: 0,
    durationMs: 0,
    segments: 0,
    pending: 0,
  };

  async function stopFromConsole(): Promise<CaptureSummary> {
    const finished = await endMeeting();
    if (finished === null) return { ...lastCaptureSummary };
    lastCaptureSummary = {
      sessionId: finished.id,
      endedAtMs: Date.now(),
      durationMs: finished.recordedMs,
      segments: finished.transcript.length,
      // What the queue is *still* holding for this meeting after the drain
      // `endMeeting` already ran. The page reads it to say "queued" rather than
      // "saved", which is the rule `docs/decisions/app-and-console.md` states.
      pending: outbox.entries.filter((entry) => entry.sessionId === finished.id).length,
    };
    return { ...lastCaptureSummary };
  }

  /**
   * Open the hosted console, when this launch was asked to.
   *
   * The bridge is registered **before** the window exists — `window` is a
   * getter for exactly that reason — because the preload's two synchronous
   * calls happen while the page is loading, and a handler registered after
   * `loadURL` is a race whose losing side is a window with no bridge on it.
   *
   * A misconfigured `CONTEXT_DESKTOP_UI_URL` throws in `consoleUrl` and is
   * caught here: the flag is a development aid today, and a typo in it must not
   * stop the tray, the detector and the queue from starting.
   */
  function openConsoleWindowIfAsked(): void {
    if (!CONSOLE_UI) return;
    let url: string;
    try {
      /*
        `app.isPackaged`, and it is the whole of the fix for a signed build that
        opened a blank window: the fallback used to be chosen by `NODE_ENV`,
        which nothing in this repository or in macOS ever sets, so an installed
        app pointed at `http://localhost:8081`. See `consoleUrl`'s own docblock.
      */
      url = consoleUrl(process.env, app.isPackaged);
    } catch (error) {
      console.error(`CONTEXT_DESKTOP_UI=console, but ${(error as Error).message}`);
      return;
    }
    consoleAddress = url;

    const origin = consoleOrigin(url);
    consoleMirror = createConsoleMirror({
      liveUrl: url,
      liveOrigin: origin,
      userDataDir: app.getPath("userData"),
      appVersion: app.getVersion(),
      // The console window's own partition, so `app://console` exists for that
      // window and for nothing else this app ever loads.
      session: session.fromPartition("persist:console"),
    });

    consoleBridge = createConsoleBridge({
      ipc: ipcMain,
      /*
        Read on every channel rather than captured once: the pin moves to
        `app://console` when the network goes and back when it returns, and a
        bridge holding the origin it was built with would answer the wrong one
        in both directions.
      */
      pinned: () => consoleMirror?.pinnedOrigin() ?? origin,
      window: () => consoleWindow,
      shell: () => ({ app: app.getName(), version: app.getVersion(), platform: "macos" }),
      capabilities: shellCapabilities,
      startCapture: startFromConsole,
      /*
        Guarded on the state, so an out-of-order press is a no-op rather than a
        transition error.

        `#moveTo` asserts the contract's table and throws on an illegal move —
        which is right, and is checked — but the string it throws
        ("illegal meeting transition idle -> paused") is written for whoever is
        debugging this process, and `createConsoleBridge` would put it in an
        answer bound for a page served over the network. The page already
        guards its own state; this is the same guard on the side that owns the
        recorder, so the developer sentence has no way to cross.
      */
      pauseCapture: async () => {
        if (controller.view()?.state !== "recording") return;
        await controller.pause();
        push();
      },
      resumeCapture: async () => {
        if (controller.view()?.state !== "paused") return;
        await controller.resume();
        push();
      },
      stopCapture: stopFromConsole,
      connection: () => uiState().connection,
      connect: () => void connectThisMachine(),
      disconnect: () => void disconnectThisMachine(),
      pendingApproval: () => {
        const pending = handover.pending();
        return pending === null ? null : { requestId: pending.requestId };
      },
      resolveApproval: (result) => answerFromConsole(result),
      outbox: outboxStatus,
      drain: () => void drain(),
      writeMeeting: writeMeetingFromConsole,
      imessage: () => imessage.status(),
      setImessageEnabled: (enabled) => void update({ imessageEnabled: enabled }),
    });

    consoleWindow = createConsoleWindow(url, RENDERER_DIR, {
      approvalCallback: () => approval.callback(),
    });
    // Before the load can finish or fail: the mirror owns `did-fail-load`, and
    // a fallback wired after the first load is a fallback that misses it.
    consoleMirror.attach(consoleWindow);
    /*
      Registered here, at creation, rather than wherever `--smoke-load` reads
      it: the window's `loadURL` is already under way inside
      `createConsoleWindow`, so a listener attached any later than this is a
      listener that can lose the race to a fast local load. `.once` on both
      events, so whichever fires first is the answer — a later navigation to
      the mirror or the failure page is the fallback taking over and is
      deliberately not what this promise reports.
    */
    const settlingWindow = consoleWindow;
    consoleLoadSettled = new Promise<boolean>((resolveSettled) => {
      let settled = false;
      const finish = (loaded: boolean): void => {
        if (settled) return;
        settled = true;
        resolveSettled(loaded);
      };
      settlingWindow.webContents.once("did-finish-load", () => finish(true));
      settlingWindow.webContents.once(
        "did-fail-load",
        (_event, _errorCode, _errorDescription, _failedUrl, isMainFrame) => {
          if (isMainFrame) finish(false);
        },
      );
      settlingWindow.once("closed", () => finish(false));
    });
    consoleWindow.once("ready-to-show", () => consoleWindow?.show());
    consoleWindow.on("closed", () => {
      /*
        The window is gone, so the channels go with it.

        Not merely tidiness: `handle` throws if a channel is registered twice,
        and leaving ten handlers behind whose only behaviour is to refuse
        everything is a surface that looks answered and is not. The bridge is
        rebuilt with the window if one is ever opened again.
      */
      consoleWindow = null;
      consoleBridge?.dispose();
      consoleBridge = null;
      consoleMirror = null;
    });
  }

  /* --- what a window is allowed to ask for ------------------------------ */

  ipcMain.on(COMMANDS.accept, (_event, episode: string) => {
    // See the header: an answer to a meeting that is over is not consent for
    // the one that is happening now.
    const current = lastUpdate ? episodeKey(lastUpdate.state) : null;
    if (current === null || current !== episode) return;
    consent = answered(episode, "granted");
    void pressed("accept", () => beginMeeting(episode));
  });
  ipcMain.on(COMMANDS.decline, (_event, episode: string) => {
    consent = answered(episode, "declined");
    panel?.hide();
    push();
  });
  ipcMain.on(COMMANDS.pause, () => void pressed("pause", () => controller.pause().then(push)));
  ipcMain.on(COMMANDS.resume, () => void pressed("resume", () => controller.resume().then(push)));
  ipcMain.on(COMMANDS.end, () => void pressed("end", () => endMeeting()));
  ipcMain.on(COMMANDS.notes, (_event, markdown: string) => controller.notes(String(markdown)));
  ipcMain.on(COMMANDS.title, (_event, title: string) => controller.title(String(title).slice(0, 200)));
  ipcMain.on(COMMANDS.setAskBeforeEveryMeeting, (_event, value: boolean) =>
    void update({ askBeforeEveryMeeting: Boolean(value) }),
  );
  ipcMain.on(COMMANDS.setBlocklist, (_event, list: string[]) =>
    void update({
      blocklist: Array.isArray(list) ? list.map(String).filter((entry) => entry.trim() !== "") : [],
    }),
  );
  ipcMain.on(COMMANDS.record, () => void pressed("record", () => recordNow()));
  ipcMain.on(COMMANDS.connect, () => void connectThisMachine());
  ipcMain.on(COMMANDS.disconnect, () => void disconnectThisMachine());

  /** The console window, when this launch has a live one. `null` otherwise. */
  function liveConsoleWindow(): BrowserWindow | null {
    try {
      if (consoleWindow === null || consoleWindow.isDestroyed()) return null;
      return consoleWindow;
    } catch {
      // A window torn down between the two reads. No window is the honest
      // answer, and it puts the approval back in the system browser.
      return null;
    }
  }

  /**
   * Show the approve screen **in this app's own window**, and say whether it
   * went.
   *
   * `false` is not a failure: it means this launch has no console window (the
   * tray-only mode still exists), or the authorization server named an
   * authorize URL this shell will not navigate its own window to, and the
   * caller falls back to the system browser — which is what this app did until
   * now and still does for everybody without a window.
   *
   * The whole of the rule is `core/shell/approval.ts`. What is here is the
   * Electron half: read where the window is so it can be put back, open the
   * allowance, navigate, and raise the window so the approve screen is in front
   * of the person who just pressed Connect rather than behind their editor.
   */
  async function approveInConsoleWindow(href: string): Promise<boolean> {
    const win = liveConsoleWindow();
    if (win === null || consoleAddress === null) return false;
    const target = approvalTargetFor(href);
    if (target === null) return false;

    let from = "";
    try {
      from = win.webContents.getURL();
    } catch {
      from = "";
    }
    const authorize = approval.begin(
      target,
      returnAfterApproval(from, consoleAddress, consoleOrigin(consoleAddress)),
    );
    try {
      await win.loadURL(authorize);
    } catch {
      /*
        A load this process replaced, or a network that went away mid-flight.
        The listener is still open and the URL has already been logged, so this
        is not the end of the flow — and `finally` puts the window back on the
        console either way.
      */
    }
    win.show();
    win.focus();
    return true;
  }

  /**
   * How long the page gets to answer a parked approval before this falls back.
   *
   * Not a guess at how fast a mutation is — the page answers either way, and
   * both answers arrive in milliseconds. It is for the pages that *cannot*
   * answer: a shell hosting a bundle older than version 3, a window serving the
   * offline mirror, a page mid-navigation when the push went out. Without it,
   * those wait out the loopback listener's five minutes staring at a console
   * that says "Connecting". Four seconds is far past a round trip and far
   * short of somebody giving up.
   */
  const APPROVAL_ANSWER_MS = 4_000;

  /**
   * Ask the page to approve this machine with the session it already has.
   *
   * `true` when the page has been handed the parked request and this connect is
   * now waiting on the loopback listener; `false` when there was nothing to
   * hand over, and the caller falls back to the approve screen in this window —
   * which is #312's flow, unchanged, and still the only thing a tray-only
   * launch has.
   *
   * The whole of what is new is the first three lines: the gateway's
   * `/oauth/authorize` **parks** the request and answers `302 Location:` the
   * consent screen, so following that one hop here — in the main process, with
   * no credential in the request and none in the answer — yields the request
   * id without sending the window anywhere. `core/shell/autoGrant.ts` carries
   * the argument, including why the id is read only from the pinned origin.
   */
  async function askConsoleToApprove(href: string, target: ApprovalTarget): Promise<boolean> {
    const win = liveConsoleWindow();
    if (win === null || consoleAddress === null || consoleBridge === null) return false;

    let parked: string | null = null;
    try {
      const response = await fetch(href, { redirect: "manual" });
      if (isParkingRedirect(response.status)) {
        parked = parkedRequestFrom(
          response.headers.get("location") ?? "",
          consoleOrigin(consoleAddress),
        );
      }
    } catch {
      /*
        The network, most likely, and the fallback is the same one it has
        always been: `approveInConsoleWindow` navigates the window to the same
        URL, which fails the same way and lands on the mirror or the failure
        page. Nothing is lost by having tried.
      */
      parked = null;
    }
    if (parked === null) return false;

    let from = "";
    try {
      from = win.webContents.getURL();
    } catch {
      from = "";
    }
    /*
      The loopback allowance is opened *before* the page is told, and it is the
      same allowance as ever: `approval.begin` holds this flow's own callback
      address and `endApproval` closes it on every path out of the connect. The
      page's navigation to the redirect the control plane hands it is the one
      navigation this feature makes, and it is bounded by exactly the rule
      #312's approve screen was.
    */
    approval.begin(target, returnAfterApproval(from, consoleAddress, consoleOrigin(consoleAddress)));
    handover.begin({ requestId: parked, authorize: target.authorize });
    consoleBridge.emitPendingApproval({ requestId: parked });
    // The window is not navigated and not raised: the person is already looking
    // at the console, and this is meant to be a thing that happened rather than
    // a thing they were interrupted by.
    setTimeout(() => {
      const stale = handover.take(parked);
      if (stale === null) return;
      // Nobody answered. That is a page that could not, so the person gets the
      // screen — the same one they would have got before any of this existed.
      void fallBackToApproveScreen(stale.authorize);
    }, APPROVAL_ANSWER_MS).unref?.();
    return true;
  }

  /**
   * The page has answered a parked approval.
   *
   * Only ever about the one this machine is waiting on: `take` answers `null`
   * for anything else, so a page that reloaded, a second window, or a message
   * about a connect that is already over does nothing at all.
   *
   * An `approved: true` closes the handover and waits — the code is on its way
   * to the loopback listener, and `connectMachine` is what receives it. An
   * `approved: false` is a page that could not, and the person gets the approve
   * screen rather than a dead end.
   */
  function answerFromConsole(result: MachineApprovalResult): void {
    const pending = handover.take(result.requestId);
    if (pending === null) return;
    consoleBridge?.emitPendingApproval(null);
    if (result.approved) return;
    void fallBackToApproveScreen(pending.authorize);
  }

  /**
   * Put #312's approve screen in this window after all.
   *
   * The parked request the page could not answer is left where it is — it
   * expires on its own in ten minutes and nothing can be spent against it —
   * and the window is navigated to the authorize URL, which parks a second
   * one. That is honest rather than tidy: the alternative is this process
   * inventing a way to un-park somebody else's row, and the flow already
   * survives a request nobody answers.
   */
  async function fallBackToApproveScreen(href: string): Promise<void> {
    consoleBridge?.emitPendingApproval(null);
    if (await approveInConsoleWindow(href)) return;
    await openInSystemBrowser(href).catch(() => {
      // A machine whose browser will not open is a real case. The URL was
      // logged when the flow started and the listener is still waiting.
    });
  }

  /**
   * Put the window back where it was, and close the loopback allowance with it.
   *
   * Both halves matter and they are one call because forgetting either is the
   * defect: an allowance left open is a standing permission for a page to walk
   * to a socket on this machine, and a window left on the loopback listener's
   * "Connected" page is a person stranded on a page whose server has closed.
   */
  function endApproval(): void {
    /*
      The handover closes with the allowance, and for the same reason: an
      approval this machine is no longer waiting on must not be answerable, and
      a card left offering to mint a grant for a connect that is over is a
      button whose only outcome is a refusal. Both are idempotent, so every
      path out of `connectThisMachine` can call this.
    */
    handover.end();
    consoleBridge?.emitPendingApproval(null);
    const back = approval.end();
    if (back === null) return;
    const win = liveConsoleWindow();
    if (win === null) return;
    void win.loadURL(back).catch(() => {
      // Offline, most likely. `consoleMirror` owns the failed load and serves
      // the mirrored console in its place.
    });
  }

  /**
   * Connect this machine to a context.
   *
   * The endpoint is the person's own: self-hosting is a supported path and
   * there is no hard-coded gateway anywhere in this app. Everything after it —
   * discovery, registration, the approval, the exchange — is `packages/hook`'s
   * reviewed flow, and the record it produces goes straight to the keychain
   * without passing through a renderer.
   *
   * **The approval happens in this window when there is one.** The person is
   * already signed in to the console here; sending them to a browser where they
   * are not was two sign-ins and a tab to close for one grant. The consent
   * dialog goes with it in that case — the approve screen the control plane
   * renders *is* the consent, it names the same scopes at more length, and a
   * modal in front of it was this app asking a question the next screen asks
   * properly. Tray-only launches have no window to approve in, so they keep
   * both the dialog and the browser.
   */
  async function connectThisMachine(): Promise<void> {
    if (connecting) return;
    connecting = true;
    connectError = null;
    push();
    try {
      if (liveConsoleWindow() === null || consoleAddress === null) {
        const answer = await dialog.showMessageBox({
          type: "question",
          title: "Connect this machine",
          message: `Connect this machine to ${settings.gatewayEndpoint}`,
          detail:
            "Your browser will open so you can approve this machine. It is registered as its own connection, so you can revoke this laptop on its own — and it asks only for what a meeting needs: to write notes, at your own privacy tier.",
          buttons: ["Open my browser", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (answer.response !== 0) return;
      }

      const record = await connectMachine({
        endpoint: settings.gatewayEndpoint,
        log: (message) => console.log(message),
        openBrowser: async (href) => {
          /*
            Three ways to put this in front of the person, in the order that
            asks them for the least.

            The first is new and is the whole of this change: the console in
            this window is signed in as them, so the parked request is handed
            to *it* and answered with that session — no screen, no browser, no
            second sign-in. `docs/decisions/desktop.md` is the argument and
            `core/shell/autoGrant.ts` is the mechanism.

            The second is #312's, unchanged, and is what every refusal falls
            back to: the approve screen, in this window. The third is the
            system browser, for a tray-only launch with no window to show
            anything in.
          */
          const target = approvalTargetFor(href);
          if (target !== null && (await askConsoleToApprove(href, target))) return;
          if (await approveInConsoleWindow(href)) return;
          await openInSystemBrowser(href);
        },
      });
      await connection.connect(record);
      /*
        Two settings move, and both are consequences of the same yes.

        `gatewayBaseUrl` is kept here as well as with the credential so the
        panel can name where meetings go without unlocking anything — it is not
        a credential and never one; the value the requests use is the one stored
        beside the token.

        `captureEnabled` is switched on, and this is the only place it is.

        Two things happened in the same breath: a person approved this machine
        against their own context, in a dialog that says it is for meetings, and
        the app got somewhere to put one. That is the yes `captureEnabled`
        records. It is not turned back off on disconnect — the meetings already
        in the queue are still theirs, and a machine that forgot the answer
        every time a grant expired would ask again for no reason.
      */
      await update({ gatewayBaseUrl: record.gatewayBaseUrl, captureEnabled: true });
      /*
        Here rather than only in `finally`, because everything below this line
        takes time a person would spend looking at the loopback listener's
        "Connected" page: the transcription question is a modal over it, and the
        drain can run for as long as the queue is long. `endApproval` is
        idempotent — the `finally` still runs it, and still matters, because
        every path that does not reach this line has to close the allowance too.
      */
      endApproval();
      await askAboutTranscription();
      // Whatever the queue is holding has been waiting for exactly this.
      await drain();
    } catch (error) {
      connectError = error instanceof Error ? error.message : "the connection could not be completed";
    } finally {
      // Before `push()`, so the console the window is being returned to draws
      // the state this connect ended in rather than the one it started from.
      endApproval();
      connecting = false;
      push();
    }
  }

  /**
   * Where the audio goes, asked once, in the one place a person can answer it.
   *
   * The default is `on-device`, which is the engine that does not exist yet —
   * chosen deliberately, because the alternative is an app whose first meeting
   * streams audio off the machine because nobody was asked. So this is the ask,
   * and it is made at the moment somebody has just connected a machine to their
   * own context rather than buried in a settings pane this app does not have.
   *
   * A "not now" is a real answer and leaves the app in the honest state it was
   * already in: meetings are typed, the panel says why, and the notes still
   * land in the bucket.
   */
  async function askAboutTranscription(): Promise<void> {
    if (settings.transcription === "cloud") return;
    const answer = await dialog.showMessageBox({
      type: "question",
      title: "Transcribe meetings",
      message: "Transcribe meetings through your gateway?",
      detail:
        "Each twenty seconds of audio is sent to your own gateway, transcribed, and thrown away — it is never written to your bucket and never kept. Until you turn this on, meetings are typed: nothing opens your microphone.",
      buttons: ["Transcribe my meetings", "Not now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 0) await update({ transcription: "cloud" });
  }

  /**
   * Give the grant up.
   *
   * The outbox is deliberately left alone: somebody disconnecting has not asked
   * to lose the meetings that have not been sent yet, and connecting again
   * drains them. What goes is the credential.
   */
  async function disconnectThisMachine(): Promise<void> {
    await connection.disconnect();
    connectError = null;
    await update({ gatewayBaseUrl: null });
  }

  openConsoleWindowIfAsked();
  loop.start();
  updater.start();
  setInterval(() => void drain(), DRAIN_INTERVAL_MS);
  push();

  // A recording that is still open when somebody quits is stopped first. The
  // transcript is already in the queue; the microphone is what must not be left
  // behind.
  app.on("before-quit", (event) => {
    markQuitting();
    imessage.stop();
    if (!controller.recording) return;
    event.preventDefault();
    void endMeeting().then(() => app.quit());
  });

  /*
    Clicking the Dock tile brings the app back, which is the other half of
    having one.

    On macOS `activate` fires for a Dock click, an app-switcher pick and a
    double-click on the `.app` while it is already running. The window is
    *destroyed* when it is closed rather than hidden (see
    `openConsoleWindowIfAsked`), so this has to be able to build it again — a
    handler that only raised an existing window would leave the Dock tile inert
    for the rest of the run, which is the same bug `openConsoleWindow` was
    written for one level up, arriving through a different door.

    On a `CONTEXT_DESKTOP_UI=renderer` launch there is no console window and the
    panel is the UI, so that is what a Dock click raises.
  */
  app.on("activate", () => {
    if (panel !== null) {
      showPanel();
      return;
    }
    if (!openConsoleWindow()) explain(CONSOLE_NOTICES.noConsole);
  });

  /*
    `--smoke`: say what a running app can say, and exit with the verdict.

    Reported from the last line of `main()` on purpose — every fact below is
    only true once the whole startup path has run, and reaching this line at all
    is what proves the module graph evaluated. The exit code is the contract the
    release step reads; see the flag's own comment above.
  */
  if (SMOKE) {
    const menu = Menu.getApplicationMenu();
    const windows = BrowserWindow.getAllWindows().length;
    /*
      Electron lowercases a role, so these read `selectall` and not `selectAll`
      — the same spelling `test/launch.smoke.mjs` asserts, and the reason the
      list below is written in that case rather than the source's.
    */
    const menuRoles: string[] = (menu?.items ?? []).flatMap((item) =>
      (item.submenu?.items ?? []).map((entry) => entry.role).filter((role) => role != null),
    );

    /*
      `loaded` is honest about what plain `--smoke` never waited to find out.
      With no `--smoke-load`, this is simply whatever the window's own loading
      flag says *right now* — almost always `false`, because a remote console
      is nowhere near finished by the time `main()` reaches its last line, and
      that is the truth rather than a placeholder. `--smoke-load` is the flag
      that actually waits, up to `SMOKE_LOAD_DEADLINE_MS`, for the first
      navigation to settle one way or the other.
    */
    let loaded = consoleWindow !== null && !consoleWindow.webContents.isLoading();
    if (SMOKE_LOAD && consoleLoadSettled !== null) {
      loaded = await Promise.race([
        consoleLoadSettled,
        new Promise<boolean>((resolveTimedOut) => setTimeout(() => resolveTimedOut(false), SMOKE_LOAD_DEADLINE_MS)),
      ]);
      // A load that succeeded triggers `consoleMirror`'s own snapshot inside its
      // `did-finish-load` handler; give that its own `await`s before asking what
      // it wrote, or this would be asking the question before the write ran.
      if (loaded) await consoleMirror?.awaitSnapshot();
      /*
        A load that *failed* triggers the mirror's own fallback navigation
        inside its `did-fail-load` handler, and that navigation is still
        in-flight when `did-fail-load` returns — `win.loadURL(target)` has not
        resolved yet. Awaiting it here is what makes `consoleWindow`'s own URL
        below trustworthy: without it, an offline launch would ask "did the
        window end up on `app://console`" before it had.
      */
      if (!loaded) await consoleMirror?.awaitFallback();
    }

    /*
      The fact the earlier fix was about: not merely "was something mirrored",
      but "is the *document* — the one thing a navigation can fall back to —
      really `text/html`". `mirrorIsUsable` asks the same question of a
      manifest already on disk; this asks it of the manifest this process is
      holding right now, which on an offline `--smoke-load` may be a mirror a
      *previous* run wrote rather than one this launch just made.
    */
    const mirroredManifest = consoleMirror?.currentManifest() ?? null;
    const snapshotIndexType = mirroredManifest?.entries[mirroredManifest.index]?.contentType ?? null;
    const snapshotIsHtmlDocument =
      snapshotIndexType === null ? null : snapshotIndexType.toLowerCase().startsWith("text/html");
    /*
      Whether the window ended up showing a real mirrored document — the fact
      "no network" and "broken app" both used to look like, because neither
      one is `loaded:true`. Read only after the fallback navigation above has
      settled, so this is the URL the window actually committed to rather than
      the one it was mid-navigation toward.
    */
    const mirrorServed = wasMirrorServed(consoleWindow?.webContents.getURL() ?? "", snapshotIsHtmlDocument);

    console.log(
      `[smoke] ${JSON.stringify({
        ready: true,
        packaged: app.isPackaged,
        windows,
        // Real evidence rather than a constant: macOS answered with a frame for
        // a `Tray` this process actually owns.
        trayBounds: tray.bounds(),
        dock: app.dock?.isVisible() ? "visible" : "hidden",
        menuRoles,
        consoleUrl: consoleAddress,
        /*
          The `__dirname` change that came with building this entry as CommonJS,
          checked rather than assumed: an empty `RENDERER_DIR` is a window that
          loads, looks right and has no bridge on it. Answered from inside
          Electron because in a packaged app this path is inside the asar, which
          only Electron's patched `fs` can see.
        */
        rendererDir: RENDERER_DIR,
        rendererDirExists: existsSync(RENDERER_DIR),
        // `false` on plain `--smoke`, honestly — see this field's own comment
        // above. `--smoke-load` is the flag that actually waits for it.
        loaded,
        // `null` when nothing was ever mirrored (no console window, or
        // `--smoke-load` never got a chance to run); otherwise whether the
        // mirror's own index is a real document.
        snapshotIsHtmlDocument,
        // True when the window ended on the offline mirror with a usable
        // index — offline with a good mirror standing in for the live
        // console. See wasMirrorServed in core/shell/mirror.ts.
        mirrorServed,
      })}`,
    );
    if (windows < 1) return endSmoke(1, "no window was created");
    if (!existsSync(RENDERER_DIR)) return endSmoke(1, `the renderer directory is missing: ${RENDERER_DIR}`);

    /*
      THE VERDICT IS THE EXIT CODE, AND IT COVERS ALL THREE DEFECTS.

      The printed line above is a diagnostic; **the exit code is the contract**,
      and it is the only thing the release step reads. `test/launch.smoke.mjs`
      does assert the address and the menu from outside — but the release step
      runs the packaged binary *directly*, not the harness, because the harness
      needs a checkout and the runner has the `.app`. So a check that lives only
      in the harness is a check the release gate does not have, and F3 —
      an installed build pointed at a dead `http://localhost:8081` — would ship
      green a second time, past a gate written to catch exactly it.

      The Dock tile is the one thing still only reported and not asserted here,
      on purpose: `app.dock.isVisible()` is an answer from the window server,
      which a headless runner is entitled to answer differently, and both halves
      of it already have offline guards that cannot flake —
      `test/appShell.test.mjs` reads `LSUIElement` out of `electron-builder.yml`
      and the `RENDERER_UI`-conditional `app.dock?.hide()` out of this file.
      The harness asserts it where there is a real desktop to ask.
    */
    if (CONSOLE_UI) {
      const wrongAddress = unexpectedConsoleAddress(process.env, app.isPackaged, consoleAddress);
      if (wrongAddress !== null) return endSmoke(1, wrongAddress);

      /*
        The console hosts a text editor, and with no Edit menu Cmd-C, Cmd-V and
        Cmd-Z are dead keys — that is F2, and it is app state rather than
        anything a display server has an opinion about.
      */
      const missing = ["undo", "cut", "copy", "paste", "selectall", "close", "quit"].filter(
        (role) => !menuRoles.includes(role),
      );
      if (missing.length > 0)
        return endSmoke(1, `the application menu is missing ${missing.join(", ")}`);
    }

    /*
      Only `--smoke-load` fails on this — plain `--smoke` never waited for
      `loaded` to mean anything, and asking it to pass "the console really
      loaded" on a runner with no route to `context.lc` would just be a second,
      slower way to fail every offline CI run for a reason that has nothing to
      do with a crash.

      ONE RULE, NOT TWO: a launch fails only when neither `loaded` nor
      `mirrorServed` is true. Offline with a usable mirror is success — that is
      the whole point of keeping one — so "no network" and "broken app" must
      not share an exit code. `smokeLoadFailure` is the pure function this asks
      rather than re-deriving the rule here; see `core/shell/mirror.ts`.
    */
    if (SMOKE_LOAD) {
      const failure = smokeLoadFailure({
        loaded,
        mirrorServed,
        snapshotIsHtmlDocument,
        deadlineMs: SMOKE_LOAD_DEADLINE_MS,
      });
      if (failure !== null) return endSmoke(1, failure);
    }
    return endSmoke(0, "the app started, opened a window, and is exiting cleanly");
  }
}

/*
  Before `whenReady`, because `registerSchemesAsPrivileged` may not be called
  after it — and without it `app://console` is an opaque origin, which
  `shouldExposeBridge` refuses (correctly), so the offline console would load
  with no bridge and nothing to say about the queue.
*/
if (CONSOLE_UI) registerMirrorScheme();

/*
  A `--smoke` run always ends, and it ends with a verdict.

  Armed before `whenReady` so it covers the whole of a launch: a `main()` that
  never resolves, a promise nobody caught, an exception after load. A hung smoke
  run is a hung release job, and the one thing this flag exists to promise is
  that the process stops on its own.

  What it cannot cover is the crash it was written for — that threw while the
  module graph was still evaluating, before this line existed to run — so the
  caller keeps its own limit. See the flag's docblock.
*/
if (SMOKE) {
  // Never cleared: every way out of a `--smoke` run goes through `endSmoke`,
  // which exits the process. A timer that outlives that has nothing to fire in.
  setTimeout(
    () => endSmoke(1, `nothing finished within ${EFFECTIVE_SMOKE_DEADLINE_MS}ms`),
    EFFECTIVE_SMOKE_DEADLINE_MS,
  );
  process.on("uncaughtException", (error) => endSmoke(1, `uncaught exception: ${error.message}`));
  process.on("unhandledRejection", (reason) => endSmoke(1, `unhandled rejection: ${String(reason)}`));
}

app.whenReady().then(main);

/*
  Closing the window does not end the app, and it must not end a meeting.

  Electron's default is to quit when the last window closes on every platform
  but macOS; this handler overrides it everywhere, and the reason is stronger
  than the platform convention. The recorder, the detector, the outbox and the
  tray all live in this process and none of them needs a window: somebody who
  closes the console mid-meeting keeps their recording, the menu bar goes on
  saying it is recording, and *End & write up* still writes the note. Quitting
  is `before-quit` above, which stops the microphone first.

  Reopening is `activate` above — the Dock tile, the app switcher — and the
  menu-bar click, which is why closing the window is not a way to lose the app.
*/
app.on("window-all-closed", () => undefined);
