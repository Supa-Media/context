/**
 * What the console page may ask of this machine's recorder and queue.
 *
 * Moved from `main()` verbatim: the capabilities this build really has, the
 * capture state and queue counts the bridge publishes, and the start, write
 * and stop the page hands over — each landing on the same refusals, in the
 * same order, as the tray.
 */

import { app } from "electron";
import { release } from "node:os";
import type {
  CaptureStarted,
  CaptureStateUpdate,
  CaptureSummary,
  DesktopCapabilities,
  MeetingWrite,
  MeetingWriteAck,
  OutboxStatus,
  StartCaptureRequest,
} from "@context/desktop-bridge";
import { answered } from "../core/consent/gate.ts";
import { isBlockedSource } from "../core/consent/blocklist.ts";
import { PLAN_NOTICES, capturePlan } from "../core/capture/plan.ts";
import { misaddressedSegments, queueWrite } from "../core/sync/outbox.ts";
import { drainUrgency } from "../core/sync/drain.ts";
import { darwinMajorFrom, systemAudioCapability } from "../core/shell/capabilities.ts";
import { CONSOLE_NOTICES, logCaptureFailure, permissionNotice } from "./notices.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createConsoleCapture(ctx: MainContext): Pick<MainActions, "shellCapabilities" | "captureStateUpdate" | "outboxStatus" | "startFromConsole" | "writeMeetingFromConsole" | "stopFromConsole"> {
  const { controller, connection, capture, store, notePaths } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();
  const drain: MainActions["drain"] = () => ctx.drain();
  const beginMeeting: MainActions["beginMeeting"] = (...args) => ctx.beginMeeting(...args);
  const endMeeting: MainActions["endMeeting"] = () => ctx.endMeeting();

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
          probed: ctx.systemAudioAvailable,
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
    if (view === null) return { state: "idle", capturing: false, fault: null, notice: null };
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
      /*
        The sentence this meeting acquired, which had nowhere to go until the
        contract grew a member for it.

        `capturePlan` puts the first one here and the *transcriber* puts every
        later one — including `CAPTURE_NOTICES.refused`, "this meeting is not
        being transcribed", which is the sentence a console page could not see
        while every desktop recording was quietly producing no transcript at
        all. The panel and the tray have always read `view.notice`; this is the
        console reading the same field rather than a second one.
      */
      notice: view.notice,
    };
  }

  /** Counts, never contents. What the queue is holding right now. */
  function outboxStatus(): OutboxStatus {
    const pending = ctx.outbox.entries.filter((entry) => entry.state === "pending");
    const parked = ctx.outbox.entries.filter((entry) => entry.state === "parked");
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
    if (!ctx.settings.captureEnabled) throw new Error(PLAN_NOTICES.notConnected);

    const source = ctx.lastUpdate?.state.source ?? null;
    if (source && isBlockedSource(source, ctx.settings.blocklist)) {
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
      settings: ctx.settings,
      connected: connection.state() === "connected",
      systemAudio: ctx.systemAudioAvailable,
    });
    const wanted = plan.channels.filter((channel) =>
      channel === "mic" ? request.mic : request.systemAudio,
    );
    if (wanted.length === 0) throw new Error(plan.notice ?? CONSOLE_NOTICES.nothingToOpen);

    const episode = `console:${Date.now()}`;
    ctx.consent = answered(episode, "granted");
    const result = await beginMeeting(episode, true, request.sessionId, false);
    if (result === null || !result.ok) {
      /*
        THE REAL TEXT SURVIVES, EVEN THOUGH THE PAGE IS NOT SHOWN IT.

        This threw away `failureReason` and substituted a canned sentence, and
        nothing anywhere else logged it — so on a machine where every capture
        was failing, the only evidence was the page saying "this meeting is
        typed" and stderr carrying an Electron rejection about a video stream.
        The closed-set rule is why the page still gets a fixed sentence rather
        than the message; a log line is where the message belongs.

        `beginMeeting` has already logged the branches it handles. This covers
        the ones it cannot: a `null` result — no detection, so no meeting — and
        `not-consented`/`already-recording`, which arrive here and nowhere else.
      */
      const why = result?.why ?? "no meeting to start";
      if (why !== "permissions" && why !== "stale-permission" && why !== "transcriber") {
        logCaptureFailure(why, null);
      }
      throw new Error(
        result?.why === "permissions"
          ? permissionNotice(result.missing ?? [])
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
    /*
      A batch carrying another meeting's words is dropped by `queueWrite` — the
      rule lives in the reducer so no enqueue can skip it — and named here,
      because the reducer has nowhere to say anything.

      This is the shape of the defect that made an evening of meetings unusable:
      the page's controller kept a `onSegment` subscription per meeting and
      detached none, so it handed this function meeting N's transcript addressed
      to meeting N-1. Two ids and a count; no text.
    */
    const foreign = misaddressedSegments(write.sessionId, write.body);
    if (foreign.length > 0) {
      console.warn(
        `meeting_segment_misaddressed to=${write.sessionId} from=${foreign.join(",")} kind=${write.kind}`,
      );
    }
    ctx.outbox = queueWrite(ctx.outbox, {
      sessionId: write.sessionId,
      kind: write.kind,
      body: write.body,
      context: write.context,
      now: Date.now(),
    });
    await store.writeOutbox(ctx.outbox);
    push();

    /*
      A finalize is awaited, a session goes out now, and the other two wait for
      the timer. `drainUrgency` holds that rule and the argument for it, in the
      one place both this path and `MeetingController` read it from.

      Not an optimisation in any of the three directions. Draining on every
      `segments` write would be a request per twenty seconds of audio against
      somebody's own gateway, and the queue's whole design is that a meeting is
      sent in one pass. Draining on the finalize is what turns "queued" into a
      note path while the person is still looking at the screen that ended the
      meeting.

      The **session** is the one that changed, and it is not awaited. The page
      calls this on the path that starts a meeting; awaiting would chain behind
      whatever drain is already in flight — up to twenty-five requests on a
      machine that just came back online — and hold up the press of Record for
      all of it. Nothing is lost by not waiting: the three answers below are
      unchanged, and the page already learns about a park at the next write it
      makes, which is what this docblock says above.
    */
    const urgency = drainUrgency(write.kind);
    if (urgency === "await") await drain();
    else if (urgency === "now") void drain();

    const parked = ctx.outbox.entries.find(
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
      queued: ctx.outbox.entries.some((entry) => entry.sessionId === write.sessionId),
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
    frames: 0,
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
      /*
        Reported beside `segments` rather than folded into it, because the pair
        is the diagnosis and either alone is not.

        `frames: 0` is a microphone that produced nothing. `frames: 2,
        segments: 0` is two chunks of real audio the gateway would not take —
        which is what every desktop recording did, and which took a hand-patched
        `fetch` in this process to find out, because this payload could not say
        it. See `CaptureSummary.frames`.
      */
      frames: finished.frames,
      // What the queue is *still* holding for this meeting after the drain
      // `endMeeting` already ran. The page reads it to say "queued" rather than
      // "saved", which is the rule `docs/decisions/app-and-console.md` states.
      pending: ctx.outbox.entries.filter((entry) => entry.sessionId === finished.id).length,
    };
    return { ...lastCaptureSummary };
  }

  return { shellCapabilities, captureStateUpdate, outboxStatus, startFromConsole, writeMeetingFromConsole, stopFromConsole };
}
