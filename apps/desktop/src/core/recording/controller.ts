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
 *  2. Asks for the microphone and Screen Recording *now* — see
 *     `capture/permissions.ts` for why the moment matters.
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
  now: () => Date;
  onChange?: (view: SessionView) => void;
  newId?: () => string;
  sampleRate?: number;
}

export interface BeginInput {
  source: MeetingSource;
  title: string;
  attendees?: Attendee[];
  /** The episode key the consent gate granted. Refused if absent. */
  grantedEpisode: string | null;
  channels?: readonly ("mic" | "system")[];
}

export type BeginResult =
  | { ok: true; view: SessionView }
  | { ok: false; why: "not-consented" | "already-recording" | "permissions"; missing?: PermissionKind[] };

export class MeetingController {
  #deps: ControllerDeps;
  #view: SessionView | null = null;
  #stream: TranscriptionStream | null = null;
  #segments = 0;
  #startedAtMs = 0;

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
    const needs = CAPTURE_NEEDS.filter(
      (need) => need === "microphone" ? channels.includes("mic") : channels.includes("system"),
    );
    // Asked here and nowhere earlier: the person has just pressed a button
    // about a meeting they can see named on screen.
    const outcome = await ensureCapturePermissions(this.#deps.permissions, needs);
    if (!outcome.ok) return { ok: false, why: "permissions", missing: outcome.missing };

    const startedAt = this.#deps.now();
    const id = (this.#deps.newId ?? newMeetingId)();
    this.#startedAtMs = startedAt.getTime();
    this.#segments = 0;

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
      transcriptionLabel: this.#deps.transcriber.label,
      audioLeavesDevice: this.#deps.transcriber.audioLeavesDevice,
      capturing: false,
      notePath: null,
      failureReason: null,
    };

    try {
      this.#stream = await this.#deps.transcriber.start({
        sampleRate: this.#deps.sampleRate ?? 16_000,
        onSegment: (segment) => this.#onSegment(segment),
      });
      await this.#deps.recorder.start({
        channels,
        sampleRate: this.#deps.sampleRate ?? 16_000,
        onFrame: (frame) => this.#stream?.push(frame),
      });
    } catch (error) {
      this.#update({ state: "failed", failureReason: describe(error), capturing: false });
      return { ok: false, why: "permissions", missing: outcome.missing };
    }

    this.#moveTo("recording");
    // The session row goes out first so the gateway knows the meeting exists
    // before any segment references it — and so a meeting that crashes the app
    // ten seconds in is still a meeting somebody can find.
    this.#queue("session", this.#sessionBody());
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

    const summary = await this.#deps.recorder.stop();
    await this.#stream?.finish();
    this.#stream = null;

    const endedAt = this.#deps.now().toISOString();
    this.#update({ recordedMs: summary.recordedMs, capturing: false });
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
