import { nextRecorderState } from "@context/meetings/recorder";
import type { DesktopBridge, DesktopCapabilities } from "@context/desktop-bridge";
import type { TranscriptSegment } from "../protocol";
import type {
  CaptureOptions,
  MeetingRecorder,
  RecorderError,
  RecorderState,
} from "./index";

/**
 * Capture through the desktop shell: the same five verbs, over a bridge.
 *
 * `docs/decisions/desktop.md`, step 3. The Expo app is the UI on macOS as well
 * now, and inside the shell the *shell* holds the microphone — so this is one
 * more implementation of `MeetingRecorder`, in the folder where the other four
 * live, rather than a second capture path with its own screens. Everything
 * above `capture/` is unchanged, which is the point of the whole change: a
 * meeting recorded on a Mac goes through the same controller, the same
 * reducer, the same notepad and the same sync as one recorded on a phone.
 *
 * ## What it does not do, and why that is the product
 *
 * It never touches `getUserMedia`, never holds a `MediaStream`, and never sees
 * a byte of audio. The shell's own hidden window records; the main process
 * transcribes with **this machine's** revocable grant, and what crosses the
 * bridge is finished `TranscriptSegment`s. So "audio is transient" is satisfied
 * here by there being nothing to keep — the same way `audio.web.ts` satisfies
 * it by the blob going out of scope, one process further out.
 *
 * The console window is also never granted a media permission at all (its
 * session denies `media` and `display-capture`), so this recorder could not
 * open an input directly even if it tried. `startCapture` is a *request*: it
 * lands on the shell's consent gate, its blocklist and its tray indicator, and
 * the worst a fully compromised page can do is ask to be recorded visibly.
 *
 * ## What it is honest about
 *
 * Two things, both asked rather than assumed:
 *
 *  - **Whether it can capture at all.** A shell that reports neither a
 *    microphone nor system audio produces a notes-only recorder with a sentence
 *    about *this machine* — not about "this browser", which would send somebody
 *    to the wrong settings screen entirely.
 *  - **What it actually opened.** `startCapture` answers with what was granted,
 *    which may be less than was asked for: an unsigned build gets no loopback
 *    tap, and the person who ticked "the whole call" is told that in the
 *    recorder's own error channel rather than discovering it in the transcript.
 */

/** Everything a `RecorderError` from this module may say, and the whole of it. */
export const DESKTOP_MESSAGES = Object.freeze({
  /** The shell is there and cannot hear anything. */
  noAudio:
    "This machine's Context app isn't set up to record audio yet, so this is a typed session. Your notes still land in your bucket.",
  /** Asked for the whole call, got the microphone. */
  micOnly:
    "This machine can't capture the call's own audio, so only your side of it is being recorded. Your notes still land in your bucket.",
  /** The shell refused, or stopped, mid-meeting. */
  lost:
    "The Context app on this machine stopped recording, so the rest of this meeting is typed. Your notes still land in your bucket.",
  /** A verb the shell would not answer. Capture may still be running. */
  unreachable:
    "The Context app on this machine isn't answering. Typing still works, and your notes still land in your bucket.",
});

/**
 * A recorder backed by `window.desktop`.
 *
 * `capabilities` is passed in rather than probed here: the answer is a promise,
 * `MeetingRecorder.capability` is a property the controller reads at configure
 * time, and a capability that changed under the snapshot after the screens had
 * read it would be worse than an honest `false`. `resolveRecorder` in
 * `audio.web.ts` does the asking, once, before this exists.
 */
export function desktopRecorder(
  bridge: DesktopBridge,
  capabilities: DesktopCapabilities,
): MeetingRecorder {
  const segmentListeners = new Set<(segment: TranscriptSegment) => void>();
  const errorListeners = new Set<(error: RecorderError) => void>();

  const audio = capabilities.mic || capabilities.systemAudio;

  let state: RecorderState = "idle";
  /** Detach the shell's streams when this recorder is not recording. */
  let detach: (() => void) | null = null;

  function report(error: RecorderError): void {
    for (const listener of errorListeners) {
      try {
        listener(error);
      } catch {
        // One screen's bug is not a reason to stop somebody's meeting. Same
        // guard, same reason, as `audio.web.ts`.
      }
    }
  }

  function emit(segment: TranscriptSegment): void {
    for (const listener of segmentListeners) listener(segment);
  }

  /**
   * Listen to the shell, and be able to stop.
   *
   * Every subscription on the bridge returns its own unsubscribe — the one
   * place that surface deliberately differs from the shell's old renderer API —
   * and this is why it had to: a recorder is created per configuration and
   * `stop()` must genuinely detach, or a second meeting is fed by two
   * subscriptions and every segment is emitted twice.
   */
  function attach(): void {
    detach?.();
    const offs = [
      bridge.onSegment(emit),
      bridge.onCaptureState((update) => {
        /*
          The shell is the authority on what the device is doing — it owns the
          input — so its state is adopted rather than argued with. What is not
          adopted is silence: a shell that stops capturing without saying why
          gets this module's sentence, because "recording stopped" with no
          reason on screen is the failure mode this whole feature is written
          against.
        */
        state = update.state;
        if (update.fault !== null) report(update.fault);
        else if (state === "stopped" && !update.capturing) {
          report({ recoverable: false, message: DESKTOP_MESSAGES.lost });
        }
      }),
    ];
    detach = () => {
      for (const off of offs) off();
      detach = null;
    };
  }

  return {
    capability: {
      audio,
      systemAudio: capabilities.systemAudio,
      /*
        The shell transcribes through the gateway with this machine's own
        grant, which is the cloud tier by the definition this app already uses:
        `transcribesAt` answers "where are the words produced", and the note
        that lands in the bucket says so. On-device transcription on the desktop
        would be a second `ChunkTranscriber` in the *shell*, and this value
        would come from `capabilities()` on the day it exists.
      */
      transcribesAt: audio ? "cloud" : "nowhere",
      unavailableReason: audio ? null : DESKTOP_MESSAGES.noAudio,
    },
    get state() {
      return state;
    },

    async start(options?: CaptureOptions) {
      if (state === "recording") return;
      if (!audio) {
        // Nothing to open. The clock still runs and the notepad still works —
        // the reference experience is a notepad first — and the sentence above
        // is already on the glass.
        state = nextRecorderState(state, "start");
        return;
      }

      attach();
      const wanted = options?.systemAudio ?? capabilities.systemAudio;
      let started;
      try {
        started = await bridge.startCapture({
          /*
            The shell mints nothing. The id is the controller's, taken from the
            one place a meeting is named, so a laptop that recorded on a plane
            and drained a day later posts under the id it has been using all
            along — and the gateway upserts one note rather than two. An empty
            one would be a capture the outbox files under nothing, so it is a
            refusal rather than a default.
          */
          sessionId: requireSessionId(options),
          mic: capabilities.mic,
          systemAudio: wanted && capabilities.systemAudio,
        });
      } catch (error: unknown) {
        detach?.();
        /*
          A refusal from the shell is the same situation as a denied microphone
          in a browser: the meeting exists, the notes matter, and `start()`
          rejecting is what the controller turns into a visible state. The
          message is the shell's own sentence when it gave one — those are
          written for a person by `core/consent` and `capture/plan.ts` — and
          this module's otherwise.
        */
        throw new Error(messageOf(error, DESKTOP_MESSAGES.lost));
      }

      state = nextRecorderState(state, "start");

      /*
        Asked for the whole call and given half of it. Reported rather than
        rendered silently: `recoverable: true`, because the microphone half is
        running and the meeting is fine — it is the *claim* that would be wrong,
        not the recording.
      */
      if (wanted && capabilities.systemAudio && !started.systemAudio) {
        report({ recoverable: true, message: DESKTOP_MESSAGES.micOnly });
      }
      if (started.notice !== null) {
        report({ recoverable: true, message: started.notice });
      }
    },

    async pause() {
      if (state !== "recording") return;
      state = nextRecorderState(state, "pause");
      await call(() => bridge.pauseCapture());
    },

    async resume() {
      // A meeting that has ended does not reopen the microphone — the rule the
      // shared state machine holds, rather than a fourth copy of it here.
      const next = nextRecorderState(state, "resume");
      if (next === state) return;
      state = next;
      await call(() => bridge.resumeCapture());
    },

    async stop() {
      state = nextRecorderState(state, "stop");
      await call(() => bridge.stopCapture());
      /*
        Detached *after* the stop rather than before it: the shell emits the
        last segments of a meeting while it is closing the input, and a recorder
        that unsubscribed first would drop the final words of every meeting —
        the same ordering `audio.web.ts` gets right by awaiting its last chunk.
      */
      detach?.();
    },

    onSegment(listener) {
      segmentListeners.add(listener);
      return () => segmentListeners.delete(listener);
    },
    onError(listener) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };

  /**
   * A verb the shell may not answer.
   *
   * Pause, resume and stop are all called from teardown paths — a screen
   * unmounting, a meeting ending, a sign-out — and a rejected IPC call there
   * used to be an unhandled rejection rather than a visible problem. The state
   * has already moved by the time this runs, deliberately: the person pressed
   * pause, and a UI that snapped back to "recording" because a channel was slow
   * would be lying in the more alarming direction.
   */
  async function call(verb: () => Promise<unknown>): Promise<void> {
    try {
      await verb();
    } catch {
      report({ recoverable: true, message: DESKTOP_MESSAGES.unreachable });
    }
  }
}

/**
 * The meeting this capture belongs to, refused rather than invented.
 *
 * A generated fallback was the first version of this line and it is the wrong
 * shape: the shell's outbox is keyed by session, so a capture filed under a
 * name the app did not choose is a second meeting in somebody's bucket that
 * nothing on this device will ever reconcile. Every caller in the app passes
 * one; a caller that does not has a bug, and it should be loud on the first
 * press rather than quiet until the drain.
 */
function requireSessionId(options: CaptureOptions | undefined): string {
  const id = options?.sessionId ?? "";
  if (id === "") throw new Error(DESKTOP_MESSAGES.lost);
  return id;
}

/** The shell's own sentence when it wrote one, ours otherwise. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}
