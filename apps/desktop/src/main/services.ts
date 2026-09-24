/**
 * The long-lived services: the local agent, iMessage, the recorder and the
 * meeting controller, the updater and the detection loop.
 *
 * Moved from `main()` verbatim. Nothing here is *started* — `main()` starts
 * them, below the tray, because their callbacks reach `push()` and `push()`
 * reads the tray. See `main()` for the order.
 */

import { app } from "electron";
import { createDetectionLoop, loadDetector } from "../core/detection/loop.ts";
import { macosCollectors } from "../platform/macos/index.ts";
import { fixedCollectors } from "../core/detection/collectors.ts";
import { MeetingController } from "../core/recording/controller.ts";
import { fakeTranscriber } from "../core/capture/transcriber.ts";
import { gatewayTranscriber, speechEvidenceLine } from "../core/capture/gatewayTranscriber.ts";
import { fakeRecorder } from "../core/capture/recorder.ts";
import type { AudioRecorder } from "../core/capture/recorder.ts";
import { DesktopCaptureRecorder } from "./capture.ts";
import { electronPermissionBroker } from "./permissions.ts";
import { createLocalAgent } from "./localAgent.ts";
import { transcribeChunk } from "./transcribe.ts";
import { ImessageSyncService } from "./imessage.ts";
import { DesktopUpdater } from "./updater.ts";
import { createNotepad, createPanel } from "./windows.ts";
import { FAKE, RENDERER_DIR, RENDERER_UI } from "./launchFlags.ts";
import type { MainActions, MainContext, MainServices } from "./context.ts";
import type { PreparedLaunch } from "./startup.ts";

export async function createServices(
  ctx: MainContext,
  prepared: PreparedLaunch,
): Promise<Omit<MainServices, "store" | "tokens" | "connection" | "tray">> {
  const { store, tokens, connection, claudeBinary } = prepared;

  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();
  const drain: MainActions["drain"] = () => ctx.drain();
  const onDetection: MainActions["onDetection"] = (current) => ctx.onDetection(current);

  const localAgent = createLocalAgent({
    scratchRoot: app.getPath("userData"),
    claudePath: () => claudeBinary,
    endpoint: () => ctx.settings.gatewayEndpoint,
    token: () => tokens.read(),
  });
  const imessage = new ImessageSyncService({
    store,
    connection,
    settings: () => ctx.settings,
    onChange: (status) => {
      ctx.consoleBridge?.emitImessage(status);
      push();
    },
  });
  // `null` in console mode. Every use below is guarded rather than the flag
  // being read a second time — see `UI_MODE`.
  const panel = RENDERER_UI ? createPanel(RENDERER_DIR) : null;
  const notepad = RENDERER_UI ? createNotepad(RENDERER_DIR) : null;

  /*
    The meter goes straight from the device to the page, and past everything.

    Not through `push()` and not through the controller: the level moves ten
    times a second on the recorder's own clock, and both of those are the
    shell's *state*, which changes when somebody presses something. Routing it
    through either would mean choosing between publishing the whole shell view
    at 10Hz and publishing a level at whatever rate the shell happened to move
    — and the second of those is a bar that does not move, which is the defect
    this exists to fix.

    `consoleBridge` is read at call time rather than captured, because it is
    rebuilt whenever the console window is: a recorder holding the one that
    existed when the app launched would push into a window that is gone.
  */
  const capture = FAKE
    ? null
    : new DesktopCaptureRecorder(RENDERER_DIR, (level) => ctx.consoleBridge?.emitLevel(level));
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
      : gatewayTranscriber({
          send: (request) => transcribeChunk(connection, request),
          /*
            THE ENGINE'S OWN EVIDENCE, WHERE SOMEBODY CAN READ IT.

            One line per answered chunk, in this process's log rather than the
            transcription service's — because that service's log is in an
            account the person diagnosing a recording does not have, and not
            having it is what stopped a diagnosis on the owner's Mac. See
            `speechEvidenceLine` for the argument and for what may be in it: a
            chunk id, counts and readings, and nothing that can hold a word
            anybody said.

            Always on rather than behind a flag, deliberately. The evidence is
            wanted *after* a recording turns out wrong, and a diagnostic that
            has to be switched on beforehand is one nobody has when it matters.
          */
          onEvidence: (report) => console.log(speechEvidenceLine(report)),
        }),
    permissions: electronPermissionBroker(),
    device: { platform: "macos", name: app.getName(), appVersion: app.getVersion() },
    outbox: () => ctx.outbox,
    setOutbox: (next) => {
      ctx.outbox = next;
      void store.writeOutbox(next);
    },
    /*
      The session row goes out now, not on the thirty-second timer.

      `SEGMENT_MS` is twenty seconds and `DRAIN_INTERVAL_MS` is thirty, so a
      session write that waited for the timer arrived *after* the first chunk of
      audio it exists to make legal — every time, on every machine. The gateway
      answered that chunk with a 404 for a meeting it had never heard of, and
      the transcriber gave the whole meeting up. Fire-and-forget on purpose: the
      microphone is already open by the time this runs and nothing here may make
      the recorder wait for a network. See `drainUrgency`.
    */
    requestDrain: () => void drain(),
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
    onSegment: (segment) => ctx.consoleBridge?.emitSegment(segment),
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
    blocklist: () => ctx.settings.blocklist,
    enabled: () => ctx.settings.detectionEnabled,
    onUpdate: (update) => {
      ctx.lastUpdate = update;
      // Counts only, never a calendar name or an event title, and only when
      // there is something to diagnose — a poll where nothing refused says
      // nothing here rather than filling the log with a line every five
      // seconds forever. See `core/detection/collectors.ts`'s
      // `CollectedCalendar` and `docs/decisions/desktop-updates.md`, "The
      // one-way door", for why this exists: an empty calendar result reads
      // identically whether the collector found nothing or was refused, and
      // this is what tells the two apart from outside the app.
      if (update.calendarRefusedCount > 0) {
        console.log(`[calendar] calendars=${update.calendarCount} refused=${update.calendarRefusedCount}`);
      }
      void onDetection(update);
    },
  });

  return { localAgent, imessage, panel, notepad, capture, controller, updater, loop };
}
