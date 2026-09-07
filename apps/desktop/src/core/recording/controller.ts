/**
 * One meeting, from "yes" to a note in the bucket.
 *
 * This is the only object that opens a microphone. It exists so that the rule
 * every other file states — nothing captures without consent, the indicator is
 * on whenever audio is being captured, one file per meeting — is enforced in a
 * single place that can be driven by a test rather than by a meeting.
 *
 * ## What it does, in order
 *
 *  1. Refuses outright if consent was not granted for this episode. The gate in
 *     `consent/gate.ts` decides; this asserts.
 *  2. Asks for the microphone *now* — see `capture/permissions.ts` for why the
 *     moment matters, and for why Screen Recording is no longer on that list.
 *  3. Starts the recorder and the transcriber, and only then reports
 *     `recording`, so the always-on indicator cannot lag the capture.
 *  4. Queues the session, then segments as they arrive, then the human's notes,
 *     then a finalize. Everything goes through the outbox; nothing is posted
 *     directly, so a meeting recorded offline behaves exactly like one recorded
 *     on wifi.
 *
 * ## One file per meeting
 *
 * The owner's decision. This client never asks for a second note: the transcript
 * is part of the same session and the gateway appends it under `## Transcript`
 * in the note the finalize writes. So there is exactly one `finalize` entry per
 * session, it carries the transcript's segment count for the gateway to check
 * against what it holds, and re-finalizing a complete session returns the path
 * that already exists rather than writing a second file.
 *
 * ## What it deliberately does not do
 *
 * No enhancement, no template selection, no title generation. Those happen in
 * the gateway where the model credential lives, and a desktop client that did
 * them would be a second implementation of somebody else's job.
 */

import { MEETING_TRANSITIONS, PROTOCOL_VERSION, newMeetingId } from "../contract.ts";
import type {
  Attendee,
  MeetingDevice,
  MeetingSource,
  MeetingState,
  TranscriptSegment,
} from "../contract.ts";
import { CAPTURE_NEEDS, ensureCapturePermissions } from "../capture/permissions.ts";
import type { PermissionBroker, PermissionKind } from "../capture/permissions.ts";
import type { AudioRecorder } from "../capture/recorder.ts";
import type { Transcriber, TranscriptionStream } from "../capture/transcriber.ts";
import { queueWrite } from "../sync/outbox.ts";
import type { Outbox } from "../sync/outbox.ts";
import { drainUrgency } from "../sync/drain.ts";

/** What the notepad and the tray render. No audio, no credentials. */
export interface SessionView {
  id: string;
  title: string;
  state: MeetingState;
  startedAt: string;
  /** Audio actually captured, excluding pauses. */
  recordedMs: number;
  source: MeetingSource;
  attendees: Attendee[];
  notes: string;
  transcript: TranscriptSegment[];
  /** The rail's pill: where the audio goes. Read off the transcriber. */
  transcriptionLabel: string;
  audioLeavesDevice: boolean;
  /** True exactly while audio is being captured. Drives the visible indicator. */
  capturing: boolean;
  /**
   * CHUNKS OF AUDIO THIS MEETING HAS HANDED TO A TRANSCRIBER.
   *
   * Counted here and reported separately from `transcript.length` because the
   * two answer different questions, and telling them apart is what made the
   * `SEGMENT_MS`/`DRAIN_INTERVAL_MS` race diagnosable at all. Frames 0 is "the
   * microphone never produced anything" — a dead input, a rotation that never
   * fired. Frames many with an empty transcript is "audio was captured and the
   * far end would not take it", which is an entirely different fault with an
   * entirely different fix, and for a whole day nothing on this device could
   * distinguish them.
   *
   * `main/capture.ts` has always counted this and `RecorderSummary` has always
   * carried it; it was read once, for `recordedMs`, and the count thrown away.
   */
  frames: number;
  /**
   * Whether this meeting opened a microphone at all.
   *
   * False is a **typed meeting**, which is a first-class outcome rather than a
   * failure: nothing could transcribe, so nothing was recorded, and the notes
   * still become a note. The UI reads this rather than inferring it from an
   * empty transcript, because "recorded and said nothing" and "never recorded"
   * look identical from the transcript and are entirely different promises.
   */
  audio: boolean;
  /**
   * The one sentence to show about what this meeting is not doing, or `null`.
   *
   * Comes from `capturePlan` at the start, and from the transcriber while the
   * meeting runs. Never assembled from an upstream error — both sources have a
   * closed set of strings.
   */
  notice: string | null;
  notePath: string | null;
  failureReason: string | null;
}

export interface ControllerDeps {
  recorder: AudioRecorder;
  transcriber: Transcriber;
  permissions: PermissionBroker;
  device: MeetingDevice;
  /** Read and written whole; the caller persists it. */
  outbox: () => Outbox;
  setOutbox: (outbox: Outbox) => void;
  /**
   * Send what was just queued, without waiting for the caller's timer.
   *
   * Called for exactly one kind — `session` — and `drainUrgency` is what says
   * so, in one place both this object and the console's write path read. The
   * reason is arithmetic and it is written out there: chunks of audio rotate
   * faster than the outbox timer fires, so a session row that waits for the
   * timer always arrives *after* the first chunk that needs it, and the gateway
   * answers that chunk with a 404 for a meeting it has never heard of.
   *
   * Deliberately synchronous and returning nothing: this is on the path that
   * opens a microphone, and a round trip awaited here would be a Record button
   * that waits for somebody's gateway before it records anything.
   */
  requestDrain?: () => void;
  now: () => Date;
  onChange?: (view: SessionView) => void;
  /**
   * One finished segment, as it arrives. Fired before `onChange`.
   *
   * Separate from `onChange` because it is an *event* and `onChange` is a
   * state: the view carries the whole transcript on every keystroke, and a
   * subscriber that had to diff two arrays to find the new words would be a
   * second implementation of what this class already knows. The desktop bridge
   * is the caller — `docs/decisions/desktop.md`'s `onSegment` — and a page
   * cannot be handed the transcript array itself.
   */
  onSegment?: (segment: TranscriptSegment) => void;
  newId?: () => string;
  sampleRate?: number;
}

export interface BeginInput {
  /**
   * The id this meeting is filed under, when somebody else already minted one.
   *
   * Absent everywhere the shell starts a meeting itself — the tray, the panel —
   * and present when the **console** started it: the page mints the id, its own
   * record is keyed on it, and the outbox files every write for this session
   * under it. Two ids for one meeting would be two notes in somebody's bucket
   * that nothing on this device could ever reconcile, so this is passed rather
   * than the shell answering back with an id the page then has to adopt.
   */
  id?: string;
  source: MeetingSource;
  title: string;
  attendees?: Attendee[];
  /** The episode key the consent gate granted. Refused if absent. */
  grantedEpisode: string | null;
  /**
   * Which streams to open. **Empty is meaningful**: it is a typed meeting, and
   * it opens nothing — no microphone, no system tap, and no permission dialog.
   * `capturePlan` is what produces it, and its whole argument is that a
   * microphone nobody will transcribe must not be opened at all.
   */
  channels?: readonly ("mic" | "system")[];
  /** What `capturePlan` said this meeting is not doing, shown as it stands. */
  notice?: string | null;
  /**
   * Whether this controller queues the writes for this meeting. Default `true`.
   *
   * **False when the console started it**, and that is a decision rather than a
   * switch. On that path the *page* holds the meeting — its own record, its own
   * notes, its own destination — and hands each write to the shell's queue over
   * the bridge. If this controller also queued, both would collapse onto the
   * same `${sessionId}:${kind}` entries and the last one in would win: the
   * shell's `end()` queues an **empty** `notes` and a finalize, drains them, and
   * the gateway writes the note before the person's typed notes have left the
   * page. One meeting is one writer, and on that path it is not this object.
   *
   * What stays true either way: this controller is still the only thing that
   * opens a microphone, still holds the consent gate, and still transcribes
   * with this machine's grant. What changes is only who files the result.
   */
  queueWrites?: boolean;
}

/**
 * Why a `begin()` did not begin.
 *
 * **Every value names its own subsystem, and `"permissions"` is the narrowest
 * of them.** It may be returned only where `ensureCapturePermissions` actually
 * read something as not-granted, and it always arrives with the `missing` list
 * that says which — nothing downstream should have to guess "the microphone"
 * because that is the usual one. `"transcriber"` exists because a transcriber
 * that threw used to be reported as `"permissions"` from a catch where
 * `outcome.ok` was already true and `outcome.missing` was already empty: a lie
 * by construction, and one that sent a person to a System Settings toggle over
 * an engine that had failed.
 */
export type BeginWhy =
  | "not-consented"
  | "already-recording"
  | "permissions"
  | "stale-permission"
  | "transcriber";

export type BeginResult =
  | { ok: true; view: SessionView }
  | {
      ok: false;
      why: BeginWhy;
      /** Which permissions macOS refused. Non-empty exactly when `why` is `"permissions"`. */
      missing?: PermissionKind[];
      /**
       * The original text of whatever actually failed, kept whole.
       *
       * For a log, and for the same string this class already puts on
       * `SessionView.failureReason` — never assembled into one of the
       * closed-set sentences a person is shown, for the reason `PLAN_NOTICES`
       * and `CONSOLE_NOTICES` are frozen. It exists because the shell
       * substituted a canned sentence at the top of this call and the real
       * message then went nowhere at all: nothing in `apps/desktop/src` logged
       * a capture failure, so a machine that could not open an input said
       * "this meeting is typed" and kept the reason entirely to itself.
       */
      message?: string;
    };

export class MeetingController {
  #deps: ControllerDeps;
  #view: SessionView | null = null;
  #stream: TranscriptionStream | null = null;
  #segments = 0;
  /** See `SessionView.frames`. Live, so it is readable during the meeting. */
  #frames = 0;
  #startedAtMs = 0;
  /** See `BeginInput.queueWrites`. True for every meeting this shell starts. */
  #queues = true;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
  }

  view(): SessionView | null {
    return this.#view;
  }

  get recording(): boolean {
    return this.#view !== null && (this.#view.state === "recording" || this.#view.state === "paused");
  }

  /**
   * Legal moves only. `MEETING_TRANSITIONS` is the contract's table, so a state
   * this client cannot reach is a bug here rather than a shape the gateway has
   * to defend against.
   */
  #moveTo(state: MeetingState): void {
    const view = this.#view;
    if (!view) throw new Error("no session");
    const allowed = MEETING_TRANSITIONS[view.state];
    if (!allowed.includes(state)) {
      throw new Error(`illegal meeting transition ${view.state} -> ${state}`);
    }
    this.#update({ state });
  }

  #update(patch: Partial<SessionView>): void {
    if (!this.#view) return;
    this.#view = { ...this.#view, ...patch, capturing: this.#deps.recorder.capturing };
    this.#deps.onChange?.(this.#view);
  }

  #queue(kind: "session" | "segments" | "notes" | "finalize", body: Record<string, unknown>): void {
    const view = this.#view;
    if (!view) return;
    // See `BeginInput.queueWrites`: one meeting is one writer, and on the
    // console path it is the page rather than this object.
    if (!this.#queues) return;
    this.#deps.setOutbox(
      queueWrite(this.#deps.outbox(), {
        sessionId: view.id,
        kind,
        body,
        now: this.#deps.now().getTime(),
      }),
    );
  }

  async begin(input: BeginInput): Promise<BeginResult> {
    if (input.grantedEpisode === null) return { ok: false, why: "not-consented" };
    if (this.recording) return { ok: false, why: "already-recording" };

    const channels = input.channels ?? (["mic", "system"] as const);
    const audio = channels.length > 0;
    const needs = CAPTURE_NEEDS.filter(
      (need) => need === "microphone" ? channels.includes("mic") : channels.includes("system"),
    );
    /*
      Asked here and nowhere earlier: the person has just pressed a button about
      a meeting they can see named on screen.

      A typed meeting asks for **nothing**, and that falls out of `needs` being
      derived from the channels rather than from a constant — no channels, no
      needs, no dialog. It is worth naming because it is not an optimisation:
      macOS remembers a refusal, so raising the microphone dialog for a session
      that is not going to open a microphone spends the one prompt a person ever
      gets, and teaches them that this app asks for the microphone at times it
      does not need it.
    */
    const outcome = await ensureCapturePermissions(this.#deps.permissions, needs);
    if (!outcome.ok) return { ok: false, why: "permissions", missing: outcome.missing };

    const startedAt = this.#deps.now();
    const id = input.id ?? (this.#deps.newId ?? newMeetingId)();
    this.#queues = input.queueWrites ?? true;
    this.#startedAtMs = startedAt.getTime();
    this.#segments = 0;
    this.#frames = 0;

    this.#view = {
      id,
      title: input.title,
      state: "idle",
      startedAt: startedAt.toISOString(),
      recordedMs: 0,
      source: input.source,
      attendees: input.attendees ?? [],
      notes: "",
      transcript: [],
      // A typed meeting has no engine, and the rail must not claim one. This is
      // the field the "on device" pill is read off, so a label that survived
      // into a session with no transcriber would be the app lying about where
      // audio went — in a session where there was none.
      transcriptionLabel: audio ? this.#deps.transcriber.label : "typed",
      audioLeavesDevice: audio ? this.#deps.transcriber.audioLeavesDevice : false,
      capturing: false,
      frames: 0,
      audio,
      notice: input.notice ?? null,
      notePath: null,
      failureReason: null,
    };

    if (audio) {
      try {
        this.#stream = await this.#deps.transcriber.start({
          sessionId: id,
          sampleRate: this.#deps.sampleRate ?? 16_000,
          onSegment: (segment) => this.#onSegment(segment),
          onNotice: (notice) => this.#update({ notice: notice.message }),
        });
      } catch (error) {
        /*
          THE TRANSCRIBER FAILED, AND IT SAYS SO IN ITS OWN WORDS.

          This returned `why: "permissions", missing: outcome.missing` — from
          inside a branch that is only reachable *after* `outcome.ok` came back
          true, with `outcome.missing` therefore empty. So the shell was told
          "macOS refused a permission" and handed an empty list of which one,
          for a failure macOS had no part in, and every renderer downstream
          filled the blank with the microphone. A person whose gateway was
          unreachable was sent to System Settings to enable a permission that
          was already on.

          The subsystem names itself now, and the engine's own message travels
          with it rather than being replaced by a sentence about permissions.
        */
        const message = describe(error);
        this.#update({ state: "failed", failureReason: message, capturing: false });
        return { ok: false, why: "transcriber", message };
      }
      try {
        await this.#deps.recorder.start({
          channels,
          sampleRate: this.#deps.sampleRate ?? 16_000,
          /*
            Counted on the way past, not inferred afterwards.

            The recorder's own `frames` only exists once `stop()` has been
            called, and "how much audio has this meeting produced" is a question
            worth being able to answer *during* the meeting — it is the one that
            separates a dead microphone from a gateway refusing the audio, and
            nothing could answer it while a recording was in progress.
            `end()` reconciles this against the recorder's authoritative count.
          */
          onFrame: (frame) => {
            this.#frames += 1;
            this.#update({ frames: this.#frames });
            this.#stream?.push(frame);
          },
        });
      } catch (error) {
        const message = describe(error);
        this.#update({ state: "failed", failureReason: message, capturing: false });
        /*
          `outcome.ok` is true here — `ensureCapturePermissions` already read
          `granted` for everything this meeting needs — and the input still
          would not open. Found on the owner's own hardware: macOS recorded the
          grant mid-run, but the process that was already running kept
          reporting (and behaving on) the answer it observed the *first* time
          it asked. `getMediaAccessStatus` is honest and re-read fresh on every
          `begin()` (see `capture/permissions.ts`); it is AVFoundation's
          per-process authorization, not this status call, that can lag a grant
          made in System Settings until the process relaunches.

          Reported as a *different* `why` than "permissions" on purpose: that
          one means "macOS says no", and its own recovery ("open System
          Settings, enable it, record again") is exactly the toggle this person
          already flipped. Telling them to flip it again is the same wrong
          instruction this section exists to remove, just for a different
          reason. `missing` stays empty — nothing is missing, this process is
          stale — so the panel can tell the two apart without re-deriving it.

          The recorder's own words travel with it too. The *sentence* a person
          is shown is still the closed set's, because "quit and reopen" is the
          only instruction that recovers this; the message is what a log needs
          in order to say which input refused and why.
        */
        return { ok: false, why: "stale-permission", missing: [], message };
      }
    }

    this.#moveTo("recording");
    // The session row goes out first so the gateway knows the meeting exists
    // before any segment references it — and so a meeting that crashes the app
    // ten seconds in is still a meeting somebody can find.
    this.#queue("session", this.#sessionBody());
    /*
      And it is *sent* first, rather than queued first and sent whenever.

      Here rather than inside `#queue`, and that placement is the whole of the
      care in this line. `#queue("session", …)` also runs from `title()` — which
      the notepad calls on every keystroke of the title field — and from `end()`,
      which drains on its own path anyway. A drain hung off the queue call would
      be one HTTP request per keystroke, which is the failure `SYNC_THROTTLE_MS`
      and `reconcileDrain` both exist to avoid, introduced while fixing a
      different one. What races the first chunk of audio is the **first** session
      write of a meeting, and this is the only place that happens.

      `drainUrgency` is asked rather than assumed, so this and
      `writeMeetingFromConsole` cannot drift on which kinds are urgent.
    */
    if (this.#queues && drainUrgency("session") === "now") this.#deps.requestDrain?.();
    return { ok: true, view: this.#view };
  }

  #sessionBody(): Record<string, unknown> {
    const view = this.#view;
    if (!view) return {};
    return {
      id: view.id,
      version: PROTOCOL_VERSION,
      title: view.title,
      state: view.state,
      startedAt: view.startedAt,
      endedAt: null,
      recordedMs: view.recordedMs,
      source: view.source,
      attendees: view.attendees,
      device: this.#deps.device,
    };
  }

  #onSegment(segment: TranscriptSegment): void {
    const view = this.#view;
    if (!view) return;
    this.#segments += 1;
    this.#deps.onSegment?.(segment);
    this.#update({ transcript: [...view.transcript, segment] });
    // Queued one at a time; `queueWrite` collapses them into a single pending
    // entry keyed on segment id, so a two-hour meeting is one request rather
    // than four thousand.
    this.#queue("segments", { sessionId: view.id, segments: [segment] });
  }

  async pause(): Promise<void> {
    this.#moveTo("paused");
    await this.#deps.recorder.pause();
    this.#update({});
  }

  async resume(): Promise<void> {
    this.#moveTo("recording");
    await this.#deps.recorder.resume();
    this.#update({});
  }

  /** The human's own Markdown. Never rewritten by anything downstream. */
  notes(markdown: string): void {
    if (!this.#view) return;
    this.#update({ notes: markdown });
    this.#queue("notes", { sessionId: this.#view.id, notes: markdown });
  }

  title(title: string): void {
    if (!this.#view) return;
    this.#update({ title });
    this.#queue("session", this.#sessionBody());
  }

  /**
   * End the meeting and ask the gateway to write the note.
   *
   * The recorder is stopped before the state moves to `complete`, so there is
   * no window in which the app reports "done" while a microphone is still open.
   */
  async end(): Promise<SessionView | null> {
    const view = this.#view;
    if (!view) return null;
    this.#moveTo("finalizing");

    // A typed meeting never started either, and asking a recorder that was
    // never given a stream to stop is how a future implementation grows a
    // "stop before start" bug that only appears for the people who could not
    // transcribe in the first place.
    const summary = view.audio ? await this.#deps.recorder.stop() : { recordedMs: 0, frames: 0 };
    await this.#stream?.finish();
    this.#stream = null;

    const endedAt = this.#deps.now().toISOString();
    /*
      The recorder's count wins at the end, and this is the only place the two
      can disagree.

      `#frames` counts what reached the transcriber's sink; `summary.frames`
      counts what the recorder produced. They are the same number today —
      `main/capture.ts` increments and calls the sink in one place — and if a
      future recorder ever drops a frame between the two, the honest answer to
      "how much audio did this meeting produce" is the recorder's.
    */
    this.#frames = summary.frames;
    this.#update({ recordedMs: summary.recordedMs, frames: summary.frames, capturing: false });
    this.#queue("session", { ...this.#sessionBody(), state: "finalizing", endedAt, recordedMs: summary.recordedMs });
    this.#queue("finalize", {
      sessionId: view.id,
      endedAt,
      recordedMs: summary.recordedMs,
      // What this client believes it sent. The gateway does not require it —
      // it counts the segments it holds — but a receipt that disagrees with
      // this number is how a note written with half a transcript gets noticed
      // at all, so it is sent.
      segmentCount: this.#segments,
      notes: this.#view?.notes ?? "",
    });

    // `complete` here means "this client is done with it", not "the note
    // exists" — the note exists when the finalize drains. The queue is what
    // knows the difference, and the UI reads the queue, not this flag.
    this.#moveTo("complete");
    return this.#view;
  }

  /**
   * Say something about this meeting that is not about its content.
   *
   * "System audio was not available", "nothing is transcribing this". It is
   * carried on the session so the panel and the notepad show the same sentence,
   * and it is deliberately *not* queued: the gateway is not told what this
   * machine could not do, because the note is about the meeting rather than
   * about the recorder.
   */
  notice(message: string | null): void {
    if (!this.#view) return;
    this.#update({ notice: message });
  }

  /** Something broke. The session is kept so its transcript is not lost. */
  fail(reason: string): void {
    if (!this.#view) return;
    this.#update({ state: "failed", failureReason: reason, capturing: false });
  }

  /** Forget the finished meeting so the app can detect the next one. */
  clear(): void {
    this.#view = null;
  }

  /** Elapsed wall-clock, for the tray's timer. */
  elapsedMs(): number {
    if (!this.#view) return 0;
    return Math.max(0, this.#deps.now().getTime() - this.#startedAtMs);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "capture failed";
}
