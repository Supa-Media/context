/**
 * `MeetingsController`'s start/stop lifecycle: `configure`, `reset`, and
 * everything that begins, pauses, resumes or ends a recording.
 *
 * Split out of `controller.ts`, which stays the class shell (fields,
 * constructor, the store contract) and merges this mixin's methods onto its
 * prototype at module load — see `applyMixins` there. Every method here
 * still reads and writes `this.snapshot`, `this.config` and the rest of the
 * controller's fields exactly as it did before the split; nothing about
 * ordering or timing changed, only which file the text lives in. The
 * explicit `this: MeetingsControllerShape` parameter on every method is a
 * type-only addition (erased at runtime, never part of the real call) that
 * lets this file type-check the fields and sibling methods the real class and
 * the other three mixins own — see `controller/shape.ts`.
 */
import type { MeetingsControllerShape } from "./shape";
import { currentEpoch } from "../../offline/epoch";
import { onSpooledAudioChange, spooledAudioCounts, type MeetingRecorder } from "../capture";
import { newMeetingId } from "../ids";
import { NOT_DURABLE_REASON, loadMeetings } from "../local";
import { emptyAck, type MeetingRecord } from "../record";
import { mayResume } from "../resume";
import { PROTOCOL_VERSION } from "../protocol";
import { can, hasNothingCaptured, isLive, seedProjection, transcriptionFor } from "../session";
import { type ConfigureInput, type StartInput, type ContinueInput, DRAIN_DEADLINE_MS, DEFAULT_EMPTY_REASON, UNCONFIGURED } from "./types";

/**
 * Wait for `work`, or for `ms`, whichever is first. A timeout, not a
 * cancellation: `work` goes on, and whatever it has not finished is in the
 * spool by then.
 */
async function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class LifecycleMixin {
  /* ------------------------------- lifecycle ------------------------------ */

  /**
   * Point the controller at a context and read what is already on the device.
   *
   * Re-configuring for the *same* workspace is a no-op rather than a reload:
   * every screen in this feature calls it on mount, and re-reading the store
   * because somebody navigated between two of them would drop the live
   * session's projection on the floor.
   *
   * **A recording keeps the recorder it started with**, which is the half that
   * was missing. See `retainedRecorder`.
   */
  async configure(this: MeetingsControllerShape, input: ConfigureInput): Promise<void> {
    if (this.config?.workspaceId === input.workspaceId) {
      this.config = { ...input, recorder: this.retainedRecorder(input.recorder) };
      const canContinue = input.gateway.canContinue === true;
      if (this.snapshot.canContinue !== canContinue) this.set({ ...this.snapshot, canContinue });
      return;
    }

    this.config = { ...input };
    this.epoch = currentEpoch();
    this.projections.clear();
    this.activityControlTokens.clear();
    this.audioOff?.();
    this.audioOff = onSpooledAudioChange(() => {
      this.refreshAudio();
      this.requestAudioDrain();
    });
    this.set({
      ...UNCONFIGURED,
      workspaceId: input.workspaceId,
      status: "loading",
      capture: input.recorder.capability,
      offline: this.offlineNow,
      canContinue: input.gateway.canContinue === true,
    });

    const { records, unreadable } = await loadMeetings(input.store, input.workspaceId);
    for (const record of records) {
      this.projections.set(record.session.id, {
        session: record.session,
        runningSince: record.runningSince,
      });
    }

    this.set({
      ...this.snapshot,
      status: "ready",
      /*
        Counted before anything below reads it: `recoverStaleFinalizes` must
        see which meetings are waiting on audio, or a meeting that has been
        waiting offline since yesterday is failed on the first launch back.
      */
      audio: spooledAudioCounts(),
      records,
      live: records.find((record) => isLive(record.session.state)) ?? null,
      unreadable,
      durable: input.store.durable,
      durabilityReason: input.store.durable ? null : NOT_DURABLE_REASON,
      capture: input.recorder.capability,
    });

    /*
      A session left `recording` or `paused` here has no capture behind it —
      see `recoverInterruptedRecordings`'s own header for why that is certain
      rather than merely likely — so it is reconciled before anything else
      reads `live` off this snapshot and draws a timer for it.
    */
    this.recoverInterruptedRecordings();
    // A previous process cannot own a recorder after launch; clear any stale
    // system surface left visible by an unclean termination.
    this.activity.reconcile(null);

    /*
      "On app launch, any `finalizing` session older than the bound is handled
      the same way" — and opening this feature, on this device, is the closest
      thing a phone has to a launch: a session that has been `finalizing`
      since before the app was last quit is read back right here, from the
      records `loadMeetings` just restored.
    */
    this.recoverStaleFinalizes();

    /*
      Audio a previous run kept and never sent — a meeting recorded
      underground, the app killed before the drain finished. Counted above, so
      the list can say so, and sent now if there is a connection: opening the
      app is the phone's "on launch".
    */
    this.requestAudioDrain();
  }

  /**
   * The recorder to keep when something reconfigures mid-meeting.
   *
   * A recording outlives the screens that started it — that is the whole reason
   * the bar is mounted at the root and this state is not a provider — but the
   * *recorder* was being minted inside the effect that configures, so every
   * remount handed a fresh one in and the same-workspace fast path swapped it
   * into `config`. The sequence is ordinary rather than exotic: start a meeting,
   * leave the section (its layout unmounts), tap the bar, come back. `end()`
   * then stopped the new, idle object, and the one actually holding the
   * microphone kept its rotation timer, its open input and its `onSegment`
   * binding forever — shipping chunks into a session that had ended.
   *
   * So while something is live, the recorder that is live is the one that
   * stays. Everything else in the configuration is still taken from the newer
   * input: a fresh gateway or store is harmless, a fresh recorder is not.
   */
  retainedRecorder(this: MeetingsControllerShape, incoming: MeetingRecorder): MeetingRecorder {
    const current = this.config?.recorder;
    if (current === undefined || current === incoming) return incoming;
    return this.snapshot.live === null ? incoming : current;
  }

  /** Forget the configuration, for a sign-out or a context switch. */
  reset(this: MeetingsControllerShape): void {
    const activityMeetingId = this.snapshot.live?.session.id ?? null;
    this.detachRecorder();
    this.audioOff?.();
    this.audioOff = null;
    if (this.audioRetryTimer !== null) clearTimeout(this.audioRetryTimer);
    this.audioRetryTimer = null;
    this.audioAgain = false;
    for (const timer of this.persistTimers.values()) clearTimeout(timer);
    this.persistTimers.clear();
    if (this.syncTimer !== null) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.projections.clear();
    this.activityControlTokens.clear();
    this.config = null;
    this.set({ ...UNCONFIGURED, offline: this.offlineNow });
    if (activityMeetingId !== null) {
      this.activityControlTokens.delete(activityMeetingId);
      this.activity.end(activityMeetingId);
    }
    this.activity.reconcile(null);
  }

  /* ------------------------------- recording ------------------------------ */

  /**
   * Begin a meeting.
   *
   * The order is deliberate and is the one thing in this method that is not
   * obvious: the record is created and written down **before** the recorder is
   * asked to start. A recorder that refuses — a denied permission, a device
   * already in use — then leaves a real session on screen that the person can
   * type into, rather than nothing at all. The reference experience is a
   * notepad first; a refused microphone must not cost somebody their notes.
   */
  async start(this: MeetingsControllerShape, input: StartInput): Promise<string> {
    const config = this.require();
    const now = config.now?.() ?? Date.now();
    const at = new Date(now).toISOString();
    const id = newMeetingId(config.randomBytes);

    const projection = seedProjection({
      id,
      title: input.title,
      startedAt: at,
      source: input.source ?? { kind: "unknown" },
      device: config.device,
      attendees: input.attendees,
      /*
        Taken from the recorder this build has, at the one moment a session is
        built, so the note that lands in somebody's bucket says how it was made.
        It names the engine that is about to run rather than the one that turned
        out to produce words: a recorder that ships audio to a service and then
        fails still shipped it, and a note that said `none` because nothing came
        back would be wrong in the only direction that matters.
      */
      transcription: transcriptionFor(config.recorder.capability.transcribesAt),
      version: PROTOCOL_VERSION,
    });
    this.projections.set(id, projection);

    const record: MeetingRecord = {
      version: 1,
      workspaceId: config.workspaceId,
      session: projection.session,
      /*
        Written down with the meeting, at the one moment somebody said it, and
        never read back off a screen afterwards — the same rule `transcription`
        follows two lines up. Finalize is minutes later and possibly a process
        later, by which time the sheet that asked is gone.
      */
      destination: input.destination ?? null,
      ...(input.continues === undefined ? {} : { continues: input.continues }),
      acked: emptyAck(),
      runningSince: null,
      updatedAt: now,
      attempts: 0,
    };
    this.put(record, { immediate: true });

    this.apply(id, { type: "start", at });
    this.set({
      ...this.snapshot,
      captureError: null,
      backgroundCaptureWarning: null,
    });

    // Install failure reporting before opening the recorder: an audio backend
    // may synchronously downgrade background capture during `start()`.
    this.listenToRecorder(id);

    try {
      /*
        The meeting's own id goes to the recorder, and it is the only thing in
        this call that is not the person's choice.

        Every capturing recorder now mints its chunk ids from it — `audio.ts`
        and `audio.web.ts` join `desktop.ts` here, since a chunk id that names
        no meeting is a segment the identity guard
        (`assertSegmentsAddressed`/`foreignSegmentSessions`) cannot tell apart
        from a foreign one, which is what let a leaked recorder subscription
        contaminate a note undetected. `notesOnlyRecorder` and `fakeRecorder`
        still ignore it — one captures nothing, and the other only records what
        it was asked for. The desktop shell also queues writes in another
        process keyed by session, so a capture started under any other name
        would be a second meeting in somebody's bucket.
      */
      await config.recorder.start({
        sessionId: id,
        /*
          Absent means "whatever this build can do" — except where doing it
          costs the person a picker. A browser can mix a shared tab's audio in,
          and assuming that on a caller's behalf would put a screen-share
          prompt in front of a meeting nobody asked to share anything for. A
          capability with a consent step is opted into, never defaulted into.
        */
        systemAudio:
          input.systemAudio ??
          (config.recorder.capability.systemAudio &&
            !config.recorder.capability.systemAudioNeedsPicker),
      });
      // Show native recording chrome only after an audio recorder really opens.
      if (
        config.recorder.capability.audio &&
        config.recorder.state === "recording" &&
        this.snapshot.backgroundCaptureWarning === null
      ) this.updateMeetingActivity(id);
    } catch (error) {
      /*
        The session stays `recording` and the reason goes on the *snapshot*.
        Moving it to `failed` and straight back — the first version of this —
        was worse in both directions: the reducer clears `failureReason` on the
        way back to `recording`, so the sentence was lost one line after it was
        written, and while it existed the meeting was marked as having failed
        when nothing about the meeting had.

        A refused microphone is a fact about this phone. The notepad is the
        product, so it keeps running and the screen says what is not being
        captured.
      */
      this.set({
        ...this.snapshot,
        captureError:
          error instanceof Error ? error.message : "The recorder would not start.",
      });
    }

    return id;
  }

  /**
   * Pick a stopped meeting back up: record a new part that is added to its note.
   *
   * A part is an ordinary recording in every way but where it lands, so this
   * is `start` with a continuation on the record — the recorder, the notepad,
   * the lock screen and the queue do not know the difference, and the writer
   * is the only thing that does (`MeetingsGateway.finalize`'s `continues`).
   * The first part is not reopened: `complete` stays terminal.
   *
   * Refused, with `null`, wherever `mayResume` says no — something is already
   * recording, a part of this meeting has not landed yet, or this device's
   * writer cannot add to a note. The surfaces ask the same question before
   * they draw the offer; this is the answer holding when two presses race.
   */
  async continueMeeting(this: MeetingsControllerShape, input: ContinueInput): Promise<string | null> {
    if (
      !mayResume({
        records: this.snapshot.records,
        live: this.snapshot.live,
        canContinue: this.snapshot.canContinue,
        meetingId: input.continues.meetingId,
      })
    ) {
      return null;
    }
    return this.start({
      title: input.title,
      destination: input.destination ?? undefined,
      continues: input.continues,
    });
  }

  async pause(this: MeetingsControllerShape): Promise<void> {
    const live = this.snapshot.live;
    if (live === null || !can(live.session.state, "paused")) return;
    const recorder = this.require().recorder;
    try {
      await recorder.pause();
    } catch {
      this.invalidateMeetingActivity(live.session.id);
      return;
    }
    if (recorder.state !== "paused") {
      this.invalidateMeetingActivity(live.session.id);
      return;
    }
    this.apply(live.session.id, { type: "pause", at: this.nowIso() });
    this.updateMeetingActivity(live.session.id);
  }

  async resume(this: MeetingsControllerShape): Promise<void> {
    const live = this.snapshot.live;
    if (live === null || !can(live.session.state, "recording")) return;
    const recorder = this.require().recorder;
    try {
      await recorder.resume();
    } catch {
      this.invalidateMeetingActivity(live.session.id);
      return;
    }
    if (recorder.state !== "recording") {
      this.invalidateMeetingActivity(live.session.id);
      return;
    }
    this.apply(live.session.id, { type: "resume", at: this.nowIso() });
    this.updateMeetingActivity(live.session.id);
  }

  /**
   * End the meeting: stop the device, move to `finalizing`, and try to sync.
   *
   * The recorder is stopped **first and unconditionally**, before any state
   * check. A session whose state machine says it cannot end — a bug, or a
   * double press racing itself — must not leave the microphone open; on iOS
   * that is a red bar across somebody's status bar after they thought they had
   * finished.
   *
   * ## A session with nothing in it is never sent to sync
   *
   * The owner's own bug report: a refused microphone left four empty notes in
   * the bucket, one per attempt — "0 min, typed session", no transcript, no
   * typed notes. `hasNothingCaptured` is checked right here, on the device,
   * before `sync()` ever gets a chance to ask a gateway to finalize: there is
   * no request worth making for a session that has nothing in it, on either
   * writer this app holds (`createConvexGateway` writes nothing for it either,
   * defensively, in case this check is ever bypassed — see its own header).
   *
   * `captureError` is the device-local reason a recorder never got going — a
   * refused microphone, a device already in use — and it is exactly the fact
   * `MeetingSession.emptyReason` exists to carry once a meeting has nothing
   * else in it. Absent, a generic sentence takes its place rather than an
   * empty string.
   *
   * ## The wait is announced before it starts, not explained after it
   *
   * `recorder.stop()` is the slow line here and it is slow on purpose — it
   * drains the last chunk so the end of the meeting is in the note rather than
   * arriving after the first sync. Until this method published
   * `snapshot.ending`, every screen went on drawing a live recording with a
   * running clock for the whole of that drain, which is how a deliberate
   * few-second wait reads as a button that did nothing. See the field.
   *
   * Set **before** the await and cleared in a `finally` that also covers the
   * fold, so two things hold: the flag does not clear one tick *before* the
   * session leaves `recording` — which would flash the live screen back to a
   * running clock on the way to the note — and nothing thrown out of that body
   * can leave the app saying a meeting is ending forever, with End and Pause
   * both refused. The second is belt and braces rather than a live path:
   * `stopAndFold` swallows the recorder's own failure where it happens, which
   * is why the check for it sabotages the *clear* rather than the `finally`.
   *
   * The `await this.sync()` is deliberately outside it. By then the session is
   * `finalizing` and `MeetingNoteScreen` is drawn, and that screen already says
   * what the drain is doing in its own words; holding "Ending…" over a network
   * round trip would be a second, worse answer to a question already answered.
   */
  async end(this: MeetingsControllerShape): Promise<void> {
    const config = this.require();
    const activityMeetingId = this.snapshot.live?.session.id ?? null;
    if (activityMeetingId !== null) this.setEnding(activityMeetingId);
    try {
      await this.stopAndFold(config, activityMeetingId);
    } finally {
      this.setEnding(null);
    }
    /*
      THE MEETING HAS ENDED BY HERE, AND THE SLOW PART IS AFTER IT.

      `stop()` resolves once the microphone is back and the audio is off the
      device; `drain()` waits for what is still being transcribed. They used to
      be one call, and the whole of it ran before the fold above — so a session
      stayed `recording` for as long as a transcription took. The person got
      the live screen, a running clock and a microphone chip over a meeting
      they had finished: *"the post processing step was just really slow… the
      countdown doesn't stop."*

      Ordered this way the wait is unchanged in length and completely different
      to sit through: `stopAndFold` has already moved the session to
      `finalizing`, so `[id].tsx` is drawing `MeetingNoteScreen` and that screen
      says what is outstanding in its own words.

      **Before `sync()`, and that is the reason the wait exists at all.** The
      finalize composes the note from the transcript this session holds, so a
      segment that arrives after it is a note missing the end of the meeting —
      usually the decision. Waiting here is what puts it in.
    */
    if (activityMeetingId !== null) this.setTranscribing(activityMeetingId);
    try {
      await withDeadline(
        config.recorder.drain?.() ?? Promise.resolve(),
        config.drainDeadlineMs ?? DRAIN_DEADLINE_MS,
      );
    } catch {
      /*
        A drain that fails is not a reason to refuse to file the meeting. What
        it means is that some audio never came back as words — and that audio
        is now in the spool, so the note waits for it (`audioHeld`) rather than
        being written without it.
      */
    } finally {
      /*
        AND ONLY NOW STOP LISTENING.

        This used to happen straight after `stop()`, before the wait — so every
        segment that came back *during* the wait was emitted to nobody, and the
        last seconds of a meeting, the ones this wait exists for, were dropped
        on the floor. It holds the listener until the wait is over. A send that
        answers later still is not lost either: the recorder sees nobody
        listening, leaves its chunk in the spool, and the drain below delivers
        it by the meeting id it carries.
      */
      if (this.listeningFor === activityMeetingId) this.detachRecorder();
      this.setTranscribing(null);
    }
    /*
      Not awaited. A pass over kept audio is paced by the transcription budget
      — minutes, for a meeting recorded offline — and `end()` is what the
      recording bar awaits before it navigates. The note does not need this to
      finish: `sync()` holds a meeting whose audio is still waiting, and the
      drain asks for a sync when it is done.
    */
    void this.drainAudio();
    await this.sync();
  }

  /** `end()`'s body, split out so one `finally` covers all of it. */
  async stopAndFold(this: MeetingsControllerShape, 
    config: ConfigureInput,
    activityMeetingId: string | null,
  ): Promise<void> {
    await config.recorder.stop().catch(() => {
      // A recorder that will not stop is not a reason to refuse to end a
      // meeting. It is reported through `onError`, which is already wired.
    });
    if (activityMeetingId !== null) {
      this.activityControlTokens.delete(activityMeetingId);
      this.activity.end(activityMeetingId);
    }
    /*
      The listener is **not** detached here any more; `end()` does it once the
      recorder's wait is over. `capture/desktop.ts` detaches from the shell
      after the stop for the reason this used to give — the last segments are
      emitted while the input is closing — and the phone's last segments arrive
      later still, after the stop, while `drain()` waits on them. A start of the
      next meeting in that window replaces the listener anyway
      (`listenToRecorder`), so the window between two meetings is still never
      one with two listeners.

      With nothing live there is nothing to wait for, so nothing to keep a
      listener for either.
    */
    if (activityMeetingId === null) this.detachRecorder();

    const live = this.snapshot.live;
    if (live === null) return;
    const endedAt = this.nowIso();
    this.apply(live.session.id, { type: "end", at: endedAt });

    /*
      Audio still on the phone is something captured. A meeting recorded
      entirely offline has no transcript and, often, no typed notes at this
      moment — and `empty` is terminal, so calling it empty here would refuse
      every word its audio later comes back as. Re-read now rather than trusted
      to the last notification: the recorder's stop has just kept its last
      chunks, and the announcement of that is a microtask behind.
    */
    this.refreshAudio();
    const ended = this.find(live.session.id);
    if (
      ended &&
      hasNothingCaptured(ended.session) &&
      (this.snapshot.audio[live.session.id]?.kept ?? 0) === 0
    ) {
      this.apply(live.session.id, {
        type: "empty",
        at: endedAt,
        reason: this.snapshot.captureError ?? DEFAULT_EMPTY_REASON,
      });
    }

    this.flush(live.session.id);
  }

  /**
   * LISTEN TO THE RECORDER FOR **THIS** MEETING, AND STOP LISTENING FOR THE LAST.
   *
   * The handler closes over `meetingId`, which is correct and was the whole
   * problem: nothing detached the previous meeting's handler, so after two
   * meetings the recorder had two subscribers, after seven it had seven, and
   * every segment of the meeting being recorded now was folded into the record
   * of every meeting recorded before it in this process.
   *
   * What that cost, measured on the owner's Mac across one evening: eight
   * finished meetings, each carrying a `segments` write full of words spoken in
   * a *later* meeting, each refused by the gateway with 400 because the session
   * they named was already complete. The refusal is the only reason those words
   * did not reach somebody's note — `appendSegments` would have appended them
   * to the wrong meeting's transcript had that meeting still been open, and a
   * meeting whose finalize has not drained yet (a laptop on a plane) is exactly
   * that. This is the fix for that, and `foreignSegmentSessions` in the
   * contract is the guard that makes a future version of it visible instead of
   * silent.
   *
   * `detachRecorder` is also called from `reset()`: a sign-out or a context
   * switch must not leave a handler holding the previous workspace's meeting id.
   */
  listenToRecorder(this: MeetingsControllerShape, meetingId: string): void {
    const config = this.require();
    this.detachRecorder();
    this.listeningFor = meetingId;
    this.recorderOff.push(
      config.recorder.onSegment((segment) => {
        this.apply(meetingId, { type: "segment", segment });
      }),
    );
    this.recorderOff.push(config.recorder.onError((error) => {
      /*
        A capture failure never ends a meeting, recoverable or not, and it never
        moves the session's state — see `start` above. The typed notes are the
        product and they keep working; what changes is what the screen is
        allowed to claim about the transcript.

        A recoverable interruption (a phone call, Siri) also lands here so the
        chip can say so while it lasts; the next successful `start` clears it.
      */
      if (error.kind === "background-unavailable") {
        this.activityControlTokens.delete(meetingId);
        this.activity.end(meetingId);
        this.set({ ...this.snapshot, backgroundCaptureWarning: error.message });
        return;
      }
      if (!error.recoverable) {
        this.activityControlTokens.delete(meetingId);
        this.activity.end(meetingId);
      }
      this.set({ ...this.snapshot, captureError: error.message });
    }));
  }

  /** Stop listening to the recorder. Safe to call when nothing is attached. */
  detachRecorder(this: MeetingsControllerShape): void {
    const offs = this.recorderOff;
    this.recorderOff = [];
    this.listeningFor = null;
    for (const off of offs) {
      try {
        off();
      } catch {
        // A recorder that throws on unsubscribe is a recorder bug, and it must
        // not stop the next meeting from starting.
      }
    }
  }
}
