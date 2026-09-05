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

import { app, ipcMain } from "electron";
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
import { MeetingController } from "../core/recording/controller.ts";
import { unavailableTranscriber } from "../core/capture/transcriber.ts";
import { fakeTranscriber } from "../core/capture/transcriber.ts";
import { fakeRecorder } from "../core/capture/recorder.ts";
import type { AudioRecorder } from "../core/capture/recorder.ts";
import { DesktopCaptureRecorder } from "./capture.ts";
import { electronPermissionBroker } from "./permissions.ts";
import { DesktopStore } from "./store.ts";
import { emptyOutbox } from "../core/sync/outbox.ts";
import type { Outbox } from "../core/sync/outbox.ts";
import { drainOnce } from "../core/sync/drain.ts";
import { memoryTokenStore } from "../core/sync/tokenStore.ts";
import { trayPresentation } from "../core/tray/presentation.ts";
import type { TrayState } from "../core/tray/presentation.ts";
import { AppTray } from "./tray.ts";
import {
  createNotepad,
  createPanel,
  markQuitting,
  positionPanelUnderTray,
  revealNotepadQuietly,
} from "./windows.ts";
import { CHANNELS, COMMANDS } from "./ipc.ts";
import type { UiState } from "./ipc.ts";
import { DEFAULT_SETTINGS } from "../core/settings.ts";
import type { DesktopSettings } from "../core/settings.ts";

/** `--fake-signals` runs the whole app against the deterministic collectors. */
const FAKE = process.argv.includes("--fake-signals");
const RENDERER_DIR = join(import.meta.dirname, "..", "renderer");
const DRAIN_INTERVAL_MS = 30_000;

let settings: DesktopSettings = DEFAULT_SETTINGS;
let outbox: Outbox = emptyOutbox();
let consent: ConsentState = IDLE_CONSENT;
let lastUpdate: DetectionUpdate | null = null;
let missingPermissions: string[] = [];

async function main(): Promise<void> {
  // A menu-bar app, not a dock app.
  app.dock?.hide();

  const store = new DesktopStore(app.getPath("userData"));
  settings = await store.readSettings();
  outbox = await store.readOutbox();

  const tokens = memoryTokenStore(null);
  const panel = createPanel(RENDERER_DIR);
  const notepad = createNotepad(RENDERER_DIR);

  const recorder: AudioRecorder = FAKE ? fakeRecorder() : new DesktopCaptureRecorder(RENDERER_DIR);
  const controller = new MeetingController({
    recorder,
    // The real engines are not built yet; see `capture/transcriber.ts`. With
    // `--fake-signals` the notepad is driven by the fake so the window can be
    // worked on without a meeting.
    transcriber: FAKE ? fakeTranscriber("mtg_00000000000000000000") : unavailableTranscriber(settings.transcription),
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
    end: () => void endMeeting(),
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
          }
        : null,
      settings: {
        askBeforeEveryMeeting: settings.askBeforeEveryMeeting,
        blocklist: settings.blocklist,
        captureEnabled: settings.captureEnabled,
        detectionEnabled: settings.detectionEnabled,
      },
      pending: new Set(outbox.entries.map((entry) => entry.sessionId)).size,
      missingPermissions,
    };
  }

  function push(): void {
    const state = uiState();
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

  async function beginMeeting(episode: string): Promise<void> {
    const detected = lastUpdate;
    if (!detected) return;
    const result = await controller.begin({
      source: detected.state.source ?? detected.result.source,
      title: detected.result.suggestedTitle ?? "Untitled meeting",
      attendees: detected.result.suggestedAttendees,
      grantedEpisode: episode,
    });
    if (result.ok) {
      missingPermissions = [];
      if (!panel.isDestroyed()) panel.hide();
      revealNotepadQuietly(notepad);
    } else if (result.why === "permissions") {
      // The panel explains, rather than the app silently doing nothing.
      missingPermissions = [...(result.missing ?? [])];
      showPanel();
    }
    push();
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
    if (settings.gatewayBaseUrl === null) return;
    const report = await drainOnce(
      outbox,
      { baseUrl: settings.gatewayBaseUrl, token: () => tokens.read() },
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

app.whenReady().then(main);

// No windows means no app on macOS — except this one, which is a menu bar.
app.on("window-all-closed", () => undefined);
