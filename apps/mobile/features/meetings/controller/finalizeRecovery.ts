/**
 * `MeetingsController`'s finalize/recovery and gateway-sync half: recovering
 * interrupted recordings and stuck finalizes at launch, discard/retry, and
 * the drain that syncs records and kept audio to the gateway.
 *
 * Split out of `controller.ts` the same way `lifecycle.ts` is — see its
 * header for the mechanism (`applyMixins`, `controller/shape.ts`) and the
 * guarantee (no behaviour change, only file location).
 */
import type { MeetingsControllerShape } from "./shape";
import { currentEpoch } from "../../offline/epoch";
import { drainSpooledAudio, forgetMeetingAudio, spooledAudioCounts, type SpooledAudioCounts } from "../capture";
import { forgetMeeting } from "../local";
import { isSynced, reopenFinalize, retrySync } from "../record";
import { checkFinalizeTimeout } from "../recovery";
import { acceptsTranscript, hasNothingCaptured, isLive } from "../session";
import { drainMeetings } from "../sync";
import { SYNC_THROTTLE_MS, INTERRUPTED_EMPTY_REASON } from "./types";

function sameCounts(
  a: Readonly<Record<string, SpooledAudioCounts>>,
  b: Readonly<Record<string, SpooledAudioCounts>>,
): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key]?.kept === b[key]?.kept && a[key]?.waiting === b[key]?.waiting);
}

export class FinalizeRecoveryMixin {

  /**
   * A session found `recording` or `paused` when the app opens has no capture
   * behind it — not probably, unconditionally.
   *
   * Every `MeetingRecorder` this app can hand `configure()` — `capture/audio.ts`,
   * `capture/audio.web.ts`, `capture/desktop.ts`, `capture/notesOnly.ts`,
   * `capture/fake.ts` — is a fresh object that starts at `"idle"` and has no way
   * to reattach to an input a previous process was holding: there is no OS API
   * a recorder here calls to ask "is something already recording for session
   * X", and none of them tries. So the only way `configure()` — the closest
   * thing this app has to "on launch", per the header above — ever finds a
   * `live` record is that the process which was recording it is gone, and
   * `elapsedMs` computing wall clock from that record's `startedAt` is exactly
   * the zombie recording this method exists to close: a bar that has been
   * "recording" for however long the app was shut, backed by no microphone at
   * all, with the meeting row itself still reading Draft.
   *
   * The move is `fail`, chosen over two tempting alternatives. Silently
   * resetting the session to `idle` would erase the transcript and the notes
   * already captured, which is the one outcome `docs/decisions/meetings.md`'s
   * finalize-deadline section already refuses for a stale finalize — the same
   * refusal applies one state earlier. Finalizing it automatically, unasked,
   * would write a note the person never agreed was over — a meeting that was
   * merely interrupted by a restart may well continue. `fail` does neither: it
   * closes the open interval at `now` (so `elapsedMs` reports exactly what was
   * captured and stops, rather than climbing forever from a `startedAt` in the
   * past or freezing at a wall-clock instant that never happened), it keeps the
   * transcript and the notes intact, it is visible on the meeting row rather
   * than silent, and `failed -> finalizing` already exists, so
   * `retryFinalize`'s Retry reaches a real finalize with what this session
   * actually captured — the same recovery `recoverStaleFinalizes` beside this
   * gives a stuck finalize, composing rather than duplicating it.
   *
   * **Unless nothing was captured at all, in which case `fail` is the wrong
   * move and this method used to make it anyway.** `INTERRUPTED_RECORDING_REASON`
   * says "the rest of this meeting was not captured — what was recorded is kept
   * below", which is false about a session with no transcript and no typed
   * notes: there is no "rest", and nothing is kept below. Worse, `failed` here
   * reads as a *transient* outcome — Retry is right there — when a genuinely
   * empty session cannot be filed no matter how many times it is retried; the
   * gateway (and, for the ordinary end-of-meeting path, `end()` right above)
   * both already treat that as `empty`, never `failed`. Recovery at launch is
   * the one caller of `fail` that had not been taught the same check, so it
   * was the one place a killed-in-the-first-few-seconds recording still ended
   * up parked behind a message that assumed content it never had — and, once
   * parked, a stuck `session` sync step for that record could still exhaust
   * `MAX_SYNC_ATTEMPTS` and reach `markSyncFailed`'s own backstop for exactly
   * this case. Folding straight to `empty` — the same two-event path `end()`
   * takes, `end` then `empty`, since `MEETING_TRANSITIONS` only allows `empty`
   * from `finalizing` — closes both: the honest reason is on the meeting from
   * the moment the app relaunches, and there is no `failed` session left for
   * anything downstream to mis-park.
   *
   * Deliberately **not** run from `sync()`. A record legitimately `recording`
   * during this same process's lifetime is exactly what `sync()` runs beside
   * without touching, and the guarantee above holds only at the one moment a
   * fresh recorder has just been handed in — which is here, and only on the
   * branch of `configure()` that is not the same-workspace fast path (that
   * branch keeps the *live* recorder, see `retainedRecorder`, and never reaches
   * this method).
   */
  recoverInterruptedRecordings(this: MeetingsControllerShape, now?: number): void {
    const config = this.config;
    if (config === null) return;
    const at = now ?? config.now?.() ?? Date.now();

    for (const record of this.snapshot.records) {
      if (!isLive(record.session.state)) continue;
      const at_ = new Date(at).toISOString();

      /*
        Mirrors `end()`, **including the half of its question that is not
        about the session**: nothing here was ever going to be a note, so it
        is `empty` rather than a `failed` this device will only ever offer a
        Retry that cannot succeed.

        `hasNothingCaptured` alone is not that question. A meeting recorded
        entirely offline has no transcript — no chunk has reached a
        transcriber — and often no typed notes, because the person was
        listening; everything it has is audio on disk. `empty` is terminal,
        so calling it empty here would refuse every word that audio comes
        back as, which is exactly the bug `end()` carries its own kept count
        for. The counts are taken by `configure` before this runs, for
        `recoverStaleFinalizes`' sake, and they answer this too.
      */
      if (
        hasNothingCaptured(record.session) &&
        (this.snapshot.audio[record.session.id]?.kept ?? 0) === 0
      ) {
        this.apply(record.session.id, { type: "end", at: at_ });
        this.apply(record.session.id, { type: "empty", at: at_, reason: INTERRUPTED_EMPTY_REASON });
        continue;
      }

      /*
        `end`, the same event the button folds, so the ordinary queue files
        this meeting with no further press. See the header for why this
        stopped being `fail`.
      */
      this.apply(record.session.id, { type: "end", at: at_ });
      const ended = this.find(record.session.id);
      if (ended !== undefined) {
        this.put({ ...retrySync(ended), interrupted: true }, { immediate: true });
      }
    }
  }

  /**
   * A session stuck `finalizing` too long is retried once, then failed.
   *
   * The glue around `checkFinalizeTimeout` (`@context/meetings/recovery`, the
   * pure rule) — see its own header for why "retry once, then fail" rather
   * than either extreme. Called here on `configure()` (the phone's nearest
   * thing to "on launch") and at the top of `sync()`, so a session that goes
   * stale while the app stays open is not left until somebody happens to
   * relaunch it.
   *
   * `retrySync` clears `rejection` on the way through both branches: a
   * *retry* must actually reach the gateway even if a previous attempt at
   * this same finalize was parked, and a *fail* must reach it too, or the
   * local `fail` this method just folded sits on the device forever behind a
   * rejection nothing is asking it to clear.
   *
   * This changes local state and persists it, the same as every other event
   * this controller folds — it does not itself ask for a drain. `sync()`
   * calls it immediately before reading what is waiting, so a call already in
   * progress picks up the change in the same pass; a screen watching the
   * snapshot asks for one the ordinary way, through its own `requestSync()`
   * effect, the ones already wired for every other local change.
   */
  recoverStaleFinalizes(this: MeetingsControllerShape, now?: number): void {
    const config = this.config;
    if (config === null) return;
    const at = now ?? config.now?.() ?? Date.now();

    for (const record of this.snapshot.records) {
      if (record.session.state !== "finalizing") continue;
      /*
        A meeting whose audio is still on this device is not stuck, it is
        waiting — on a connection, not on a finalize that got lost. Failing it
        after ten minutes offline would put "Failed" over a meeting that is
        doing exactly what it should.
      */
      if (this.audioHeld(record.session.id)) continue;
      const outcome = checkFinalizeTimeout(record.session, at, { retriedAt: record.retriedAt ?? null });
      if (outcome.action === "none") continue;

      if (outcome.action === "retry") {
        /*
          `reopenFinalize`, not `retrySync`: a finalize the gateway accepted
          without a path has no `rejection` to clear, so `retrySync` returned
          the record untouched and this branch sent nothing at all. See that
          function's header — it is the bug that lost a meeting.
        */
        this.put(reopenFinalize({ ...record, retriedAt: at }), { immediate: true });
        continue;
      }

      this.apply(record.session.id, {
        type: "fail",
        at: new Date(at).toISOString(),
        reason: outcome.reason ?? "finalize did not complete in time",
      });
      const failed = this.find(record.session.id);
      if (failed !== undefined) this.put(retrySync(failed), { immediate: true });
    }
  }

  /** Forget a meeting on this device. The only path that destroys a recording. */
  async discard(this: MeetingsControllerShape, meetingId: string): Promise<void> {
    const config = this.require();
    const discardingLive = this.snapshot.live?.session.id === meetingId;
    if (discardingLive) {
      // Discarding the meeting that is running has to release the device as
      // well. Without this the microphone stays open with nothing left to
      // record into — on iOS, a red bar over an app that has forgotten why.
      await config.recorder.stop().catch(() => {});
      // And nothing keeps listening on behalf of a meeting that no longer
      // exists: `apply` would find no projection, but the closure would still
      // be holding the id of a recording somebody deliberately destroyed.
      this.detachRecorder();
    }
    this.cancelPersist(meetingId);
    this.activityControlTokens.delete(meetingId);
    if (discardingLive) this.activity.end(meetingId);
    this.projections.delete(meetingId);
    /*
      Its audio goes with it. A person discarding a meeting is the one act,
      besides signing out, that may remove kept audio — and leaving it would be
      minutes of a meeting on the phone that nothing would ever send or show.
    */
    forgetMeetingAudio(meetingId);
    await forgetMeeting(config.store, config.workspaceId, meetingId);
    const records = this.snapshot.records.filter((record) => record.session.id !== meetingId);
    this.set({ ...this.snapshot, records, live: records.find((r) => isLive(r.session.state)) ?? null });
  }

  /** Put a parked meeting back in the queue, at the person's request. */
  async retry(this: MeetingsControllerShape, meetingId: string): Promise<void> {
    const record = this.find(meetingId);
    if (record === undefined) return;
    this.put(retrySync(record), { immediate: true });
    await this.sync();
  }

  /**
   * Take a meeting recovery gave up on back to `finalizing`, at the person's
   * own request.
   *
   * **The other half of "retry once, then fail".** `recoverStaleFinalizes`
   * ends at a `failed` session with a reason on the badge, and
   * `MEETING_TRANSITIONS.failed` has allowed `failed -> finalizing` since a
   * partial recording had to be writable out — but nothing in this app ever
   * made that move, and `pendingSteps` only offers a `finalize` for a session
   * in `finalizing`. So without this method a stuck finalize that timed out
   * was not "failed until somebody retries", it was **never sent again**: a
   * phone that lost signal for twenty minutes after a meeting kept the words
   * somebody typed on the device permanently, behind a badge that said the
   * meeting had failed and no control that did anything about it.
   *
   * `end` is the event, exactly as `end()` folds it: it moves `failed ->
   * finalizing`, clears `failureReason` on the way through, and restamps
   * `endedAt` — which is also the clock `checkFinalizeTimeout` reads, so a
   * retry a person asked for gets its own full window rather than being
   * failed again on the next tick. `retriedAt` is cleared with it, for the
   * same reason `queueWrite` clears the desktop's copy: the one retry this
   * session had spent belongs to the attempt that failed, not to this one.
   *
   * **`acked.finalized` is cleared too, and that is the half without which
   * this method does nothing at all in the case it exists for.** The stuck
   * meeting the owner reported is a gateway that *accepted* a finalize and
   * never came back with a path — `sync.ts`'s "finalize accepted but no path
   * came back" branch — and that acknowledgement is exactly what stops
   * `pendingSteps` from offering the step again. Asking again is the whole
   * request being made here, and the protocol is idempotent by construction:
   * a second finalize on a session the gateway did write answers with the
   * note it already wrote.
   */
  async retryFinalize(this: MeetingsControllerShape, meetingId: string): Promise<void> {
    const record = this.find(meetingId);
    if (record === undefined || record.session.state !== "failed") return;
    this.apply(meetingId, { type: "end", at: this.nowIso() });
    const reopened = this.find(meetingId);
    if (reopened !== undefined) {
      this.put({ ...reopenFinalize(reopened), retriedAt: undefined }, { immediate: true });
    }
    await this.sync();
  }

  /* --------------------------------- sync --------------------------------- */

  /**
   * Ask for a drain, at most one every `SYNC_THROTTLE_MS`.
   *
   * What the app's "something changed, send it" effect calls. Everything that
   * changes a meeting changes it on a keystroke, so this is the only entry
   * point that is safe to call from a render-driven effect — see
   * `SYNC_THROTTLE_MS` for why it is a throttle rather than a debounce.
   */
  requestSync(this: MeetingsControllerShape): void {
    if (this.syncTimer !== null) return;
    const delay = this.config?.syncThrottleMs ?? SYNC_THROTTLE_MS;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.sync();
    }, delay);
  }

  /**
   * Send everything waiting.
   *
   * Guarded against overlapping runs rather than queued: two drains in flight
   * would each read the same records and send the same segments twice, which is
   * harmless by the protocol's idempotency and pointless against somebody's
   * request quota. The second caller gets the first one's outcome by watching
   * the snapshot.
   */
  async sync(this: MeetingsControllerShape): Promise<void> {
    const config = this.config;
    if (config === null || this.snapshot.syncing) return;

    // A session that went stale while the app stayed open, caught on the same
    // schedule as everything else that reaches the gateway — not only on the
    // next `configure()`. See `recoverStaleFinalizes`'s own header.
    this.recoverStaleFinalizes(config.now?.() ?? Date.now());

    const waiting = this.snapshot.records.filter(
      (record) =>
        !isSynced(record) &&
        record.rejection === undefined &&
        /*
          HELD WHILE ITS AUDIO IS STILL ON THE DEVICE.

          Finalizing composes the note from the transcript this record holds,
          and a `complete` meeting refuses every segment after it
          (`acceptsTranscript`). So a meeting finalized with chunks still in
          the spool would be a note missing part of the meeting *for good*:
          the words would arrive, and be refused. The note waits instead, and
          the screen says what it is waiting for.
        */
        !(record.session.state === "finalizing" && this.audioHeld(record.session.id)) &&
        /*
          And held while `end()` is still waiting on the recorder's last sends,
          for the same reason one step earlier. `end()` calls `sync()` itself
          once the wait is over; a drain asked for by anything else in the
          meantime — the app's "something changed" effect fires on the `end`
          event itself — would otherwise write the note without the last
          seconds of the meeting, which is exactly what the wait is for.
        */
        this.snapshot.transcribing !== record.session.id,
    );
    if (waiting.length === 0) return;

    this.set({ ...this.snapshot, syncing: true });
    try {
      const { records } = await drainMeetings(waiting, {
        gateway: config.gateway,
        now: () => config.now?.() ?? Date.now(),
        onEvents: (meetingId, events) => {
          for (const event of events) this.apply(meetingId, event);
        },
      });
      /*
        Only the sync bookkeeping is written back, never the session.

        The drain works from the records it was handed, and `onEvents` has
        already folded the gateway's answer — a `written` with the note's path —
        through the reducer while it ran. Putting the whole returned record back
        would overwrite that with the pre-drain session, so a meeting would
        finish `finalizing` forever with the path it was just given thrown away.
        Measured: `meetingsController.test.ts`'s "the device is released and the
        note is written" is the test that caught it.
      */
      for (const drained of records) {
        const current = this.find(drained.session.id) ?? drained;
        this.put(
          {
            ...current,
            acked: drained.acked,
            attempts: drained.attempts,
            rejection: drained.rejection,
            lastError: drained.lastError,
            // Sync bookkeeping like the four above it: the gateway's answer
            // about the request this drain just made, not about the session.
            ...(drained.folderRejected === true ? { folderRejected: true as const } : {}),
          },
          { immediate: true },
        );
      }
    } finally {
      this.set({ ...this.snapshot, syncing: false });
    }
  }

  /* ------------------------------ kept audio ------------------------------ */

  /**
   * Mirror the reachability hook in. Coming back is a drain.
   *
   * Two receivers and one call, on purpose: the snapshot is what the screens
   * read to say "offline — this is being kept on the phone", and the capture
   * module is what the recorder reads to decide whether to send a chunk now or
   * keep it. `useMeetingsSetup` calls this and `setCaptureOffline` together.
   */
  setOffline(this: MeetingsControllerShape, offline: boolean): void {
    this.offlineNow = offline;
    if (this.snapshot.offline !== offline) this.set({ ...this.snapshot, offline });
    if (!offline) this.requestAudioDrain();
  }

  /**
   * Send what the spool is holding for the meetings in this context.
   *
   * One pass at a time; a request made during a pass runs another after it,
   * because a chunk kept mid-pass was not in that pass's listing. A pass the
   * transcriber rate-limited comes back when it was told to. Never throws.
   */
  async drainAudio(this: MeetingsControllerShape): Promise<void> {
    if (this.audioDraining !== null) {
      this.audioAgain = true;
      return this.audioDraining;
    }
    const config = this.config;
    if (config === null || this.snapshot.offline) return;
    const epoch = this.epoch;
    const run = (async () => {
      do {
        this.audioAgain = false;
        const report = await drainSpooledAudio({
          owns: (meetingId) => {
            const projection = this.projections.get(meetingId);
            return projection !== undefined && acceptsTranscript(projection.session.state);
          },
          deliver: async (meetingId, segments) => {
            this.apply(meetingId, { type: "segments", segments });
            await this.persistNow(meetingId);
          },
          mine: () => this.config === config && epoch === currentEpoch(),
        }).catch(() => null);
        if (report?.retryAfterMs != null) this.retryAudioAfter(report.retryAfterMs);
        if (report === null || report.stoppedEarly) break;
      } while (this.audioAgain && this.config === config);
    })();
    this.audioDraining = run;
    try {
      await run;
    } finally {
      this.audioDraining = null;
    }
    if (this.config !== config) return;
    this.refreshAudio();
    /*
      A meeting whose last chunk just landed is no longer held, and its note
      can be written now rather than on the next keystroke that asks.
    */
    this.requestSync();
  }

  /** Whether this meeting's note is waiting on audio still on the device. */
  audioHeld(this: MeetingsControllerShape, meetingId: string): boolean {
    return (this.snapshot.audio[meetingId]?.waiting ?? 0) > 0;
  }

  requestAudioDrain(this: MeetingsControllerShape): void {
    if (this.config === null || this.snapshot.offline) return;
    void this.drainAudio();
  }

  retryAudioAfter(this: MeetingsControllerShape, ms: number): void {
    if (this.audioRetryTimer !== null) return;
    this.audioRetryTimer = setTimeout(() => {
      this.audioRetryTimer = null;
      this.requestAudioDrain();
    }, ms);
  }

  /** Re-read the counts, and publish only if they changed. */
  refreshAudio(this: MeetingsControllerShape): void {
    if (this.config === null) return;
    const next = spooledAudioCounts();
    if (sameCounts(this.snapshot.audio, next)) return;
    this.set({ ...this.snapshot, audio: next });
  }

  /** Write a record down now and wait for it: a spooled chunk's words, before it is let go. */
  async persistNow(this: MeetingsControllerShape, meetingId: string): Promise<void> {
    const record = this.find(meetingId);
    if (record === undefined) return;
    this.cancelPersist(meetingId);
    await this.persist(record);
  }
}
