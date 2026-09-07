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

import { app, dialog, ipcMain } from "electron";
import { join } from "node:path";
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
import { fakeTranscriber } from "../core/capture/transcriber.ts";
import { gatewayTranscriber } from "../core/capture/gatewayTranscriber.ts";
import { capturePlan } from "../core/capture/plan.ts";
import { fakeRecorder } from "../core/capture/recorder.ts";
import type { AudioRecorder } from "../core/capture/recorder.ts";
import { DesktopCaptureRecorder } from "./capture.ts";
import { electronPermissionBroker } from "./permissions.ts";
import { DesktopStore } from "./store.ts";
import { emptyOutbox } from "../core/sync/outbox.ts";
import type { Outbox } from "../core/sync/outbox.ts";
import { drainOnce } from "../core/sync/drain.ts";
import { memoryTokenStore } from "../core/sync/tokenStore.ts";
import { GatewayConnection } from "../core/sync/connection.ts";
import { keychainTokenStore } from "./tokenStore.ts";
import { browserlessRefresher, connectMachine } from "./connect.ts";
import { transcribeChunk } from "./transcribe.ts";
import { trayPresentation } from "../core/tray/presentation.ts";
import type { TrayState } from "../core/tray/presentation.ts";
import { AppTray } from "./tray.ts";
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
  mayAnswerSender,
  senderEvidenceFrom,
} from "../core/shell/console.ts";
import { CONSOLE_ORIGIN_CHANNEL, CONSOLE_SHELL_CHANNEL } from "../preload/console.ts";
import { CHANNELS, COMMANDS } from "./ipc.ts";
import type { UiState } from "./ipc.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { DesktopSettings } from "../core/settings.ts";

/** `--fake-signals` runs the whole app against the deterministic collectors. */
const FAKE = process.argv.includes("--fake-signals");
/**
 * Which UI this shell hosts. `renderer` is the panel and the notepad in
 * `src/renderer/`; `console` additionally opens `apps/mobile`'s web build.
 *
 * Default unchanged on purpose: this is step one of
 * `docs/decisions/desktop.md`'s order, and step one is allowed to change
 * nothing. The console window it opens carries a bridge with every capability
 * answering `false`, so what it proves is that the shell can host a remote
 * origin and give it nothing — not that the app has moved into it yet.
 */
const CONSOLE_UI = process.env.CONTEXT_DESKTOP_UI === "console";
const RENDERER_DIR = join(import.meta.dirname, "..", "renderer");
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
let connectError: string | null = null;

async function main(): Promise<void> {
  // A menu-bar app, not a dock app.
  app.dock?.hide();

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
  const panel = createPanel(RENDERER_DIR);
  const notepad = createNotepad(RENDERER_DIR);
  openConsoleWindowIfAsked();

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
    if (panel.isDestroyed()) return;
    positionPanelUnderTray(panel, tray.bounds());
    panel.showInactive();
  }

  const tray = new AppTray({
    togglePanel: (bounds) => {
      if (panel.isVisible()) {
        panel.hide();
        return;
      }
      positionPanelUnderTray(panel, bounds);
      panel.showInactive();
    },
    openNotepad: () => revealNotepadQuietly(notepad),
    record: () => void recordNow(),
    end: () => void endMeeting(),
    connect: () => void connectThisMachine(),
    disconnect: () => void disconnectThisMachine(),
    toggleDetection: () => void update({ detectionEnabled: !settings.detectionEnabled }),
    quit: () => app.quit(),
  });

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
        error: connectError,
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
      connected: state.connection.state === "connected",
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
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.state, state);
    }
  }

  async function update(patch: Partial<DesktopSettings>): Promise<void> {
    settings = { ...settings, ...patch };
    await store.writeSettings(settings);
    push();
  }

  async function onDetection(current: DetectionUpdate): Promise<void> {
    if (current.transition === "cleared") {
      consent = forgetEpisode(consent, consent.episode);
      if (!panel.isDestroyed()) panel.hide();
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
  async function beginMeeting(episode: string, manual = false): Promise<void> {
    const detected = manual ? null : lastUpdate;
    if (!manual && !detected) return;
    // What this machine can actually do right now, in one place. `plan.notice`
    // is the sentence the panel shows when it is less than everything.
    const plan = capturePlan({
      settings,
      connected: connection.state() === "connected",
      systemAudio: systemAudioAvailable,
    });

    const result = await controller.begin({
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
      if (!panel.isDestroyed()) panel.hide();
      revealNotepadQuietly(notepad);
    } else if (result.why === "permissions") {
      // The panel explains, rather than the app silently doing nothing.
      missingPermissions = [...(result.missing ?? [])];
      showPanel();
    }
    push();
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
      showPanel();
      return;
    }
    const source = lastUpdate?.state.source ?? null;
    if (source && isBlockedSource(source, settings.blocklist)) {
      showPanel();
      return;
    }
    const episode = `manual:${Date.now()}`;
    consent = answered(episode, "granted");
    await beginMeeting(episode, true);
  }

  async function endMeeting(): Promise<void> {
    if (!controller.recording) return;
    await controller.end();
    push();
    await drain();
    controller.clear();

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
  }

  async function drain(): Promise<void> {
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
    const report = await drainOnce(
      outbox,
      { baseUrl, token: () => connection.token() },
      () => Date.now(),
    );
    outbox = report.outbox;
    await store.writeOutbox(outbox);
    push();
  }

  /* --- what a window is allowed to ask for ------------------------------ */

  ipcMain.on(COMMANDS.accept, (_event, episode: string) => {
    // See the header: an answer to a meeting that is over is not consent for
    // the one that is happening now.
    const current = lastUpdate ? episodeKey(lastUpdate.state) : null;
    if (current === null || current !== episode) return;
    consent = answered(episode, "granted");
    void beginMeeting(episode);
  });
  ipcMain.on(COMMANDS.decline, (_event, episode: string) => {
    consent = answered(episode, "declined");
    panel.hide();
    push();
  });
  ipcMain.on(COMMANDS.pause, () => void controller.pause().then(push));
  ipcMain.on(COMMANDS.resume, () => void controller.resume().then(push));
  ipcMain.on(COMMANDS.end, () => void endMeeting());
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
  ipcMain.on(COMMANDS.record, () => void recordNow());
  ipcMain.on(COMMANDS.connect, () => void connectThisMachine());
  ipcMain.on(COMMANDS.disconnect, () => void disconnectThisMachine());

  /**
   * Connect this machine to a context.
   *
   * The endpoint is the person's own: self-hosting is a supported path and
   * there is no hard-coded gateway anywhere in this app. Everything after it —
   * discovery, registration, the browser, the exchange — is `packages/hook`'s
   * reviewed flow, and the record it produces goes straight to the keychain
   * without passing through a renderer.
   */
  async function connectThisMachine(): Promise<void> {
    if (connecting) return;
    connecting = true;
    connectError = null;
    push();
    try {
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

      const record = await connectMachine({
        endpoint: settings.gatewayEndpoint,
        log: (message) => console.log(message),
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
      await askAboutTranscription();
      // Whatever the queue is holding has been waiting for exactly this.
      await drain();
    } catch (error) {
      connectError = error instanceof Error ? error.message : "the connection could not be completed";
    } finally {
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

  loop.start();
  setInterval(() => void drain(), DRAIN_INTERVAL_MS);
  push();

  // A recording that is still open when somebody quits is stopped first. The
  // transcript is already in the queue; the microphone is what must not be left
  // behind.
  app.on("before-quit", (event) => {
    markQuitting();
    if (!controller.recording) return;
    event.preventDefault();
    void endMeeting().then(() => app.quit());
  });
}

/**
 * Open the hosted console, when this launch was asked to.
 *
 * The two `sendSync` handlers are the preload's whole conversation with this
 * process: which origin it is pinned to, and what to call this shell. Both are
 * public — the origin is already in the window's own URL bar — and neither is a
 * credential, which is the property that has to survive every future addition
 * to this surface.
 *
 * A misconfigured `CONTEXT_DESKTOP_UI_URL` throws in `consoleUrl` and is caught
 * here: the flag is a development aid today, and a typo in it must not stop the
 * tray, the detector and the queue from starting.
 */
function openConsoleWindowIfAsked(): void {
  if (!CONSOLE_UI) return;
  let url: string;
  try {
    url = consoleUrl(process.env);
  } catch (error) {
    console.error(`CONTEXT_DESKTOP_UI=console, but ${(error as Error).message}`);
    return;
  }
  const origin = consoleOrigin(url);
  const win = createConsoleWindow(url, RENDERER_DIR);
  /*
    Who the main process will answer, as `mayAnswerSender` wants it: this
    window's web contents, and its main frame rather than something it embeds.
    Both are read off `event` — a page cannot spell either of them.

    `null` is the refusal, and it is the refusal the preload already fails
    closed on: `pinnedOrigin()` does `String(… ?? "")`, and an empty pin exposes
    no bridge. `event.returnValue` has to be SET whatever the answer is, because
    a `sendSync` that no listener answers hangs the renderer.
  */
  const senderEvidence = (event: Electron.IpcMainEvent) =>
    senderEvidenceFrom(event, win.webContents);
  ipcMain.on(CONSOLE_ORIGIN_CHANNEL, (event) => {
    event.returnValue = mayAnswerSender(senderEvidence(event)) ? origin : null;
  });
  ipcMain.on(CONSOLE_SHELL_CHANNEL, (event) => {
    event.returnValue = mayAnswerSender(senderEvidence(event))
      ? { app: app.getName(), version: app.getVersion(), platform: "macos" }
      : null;
  });
  win.once("ready-to-show", () => win.show());
}

app.whenReady().then(main);

// No windows means no app on macOS — except this one, which is a menu bar.
app.on("window-all-closed", () => undefined);
