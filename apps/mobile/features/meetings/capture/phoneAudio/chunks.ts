import { File } from "expo-file-system";
import type { RecorderError } from "../index";
import { MAX_INFLIGHT_CHUNKS, chunkIdFor } from "../segments";
import { resolveTranscriber } from "../transcriber";
import {
  WAV_HEADER_SCAN_BYTES,
  WAV_MIME,
  alignToFrame,
  encodeBase64,
  parseWavHeader,
  pcmBytesForMs,
  pcmDurationMs,
  wavFile,
} from "../wav";
import type { RecorderInternals } from "./internals";
import { CHUNK_FAILED, NO_TRANSCRIBER, SEND_BACKLOG } from "./messages";
import { CHUNK_MIME, MAX_SLICE_MS } from "./recordingFormat";
import { discard, readRange } from "./recordingFiles";
import type { Sender } from "./sender";

/**
 * Turning what the microphone wrote into chunks: the continuous slicer iOS
 * uses and the rotating close Android uses. Moved out of `audio.ts` whole;
 * `abandon` is handed in because giving capture up is `interruptions.ts`'s.
 */
export function createChunks(
  rec: RecorderInternals,
  deps: {
    report(error: RecorderError): void;
    abandon(message: string): Promise<void>;
    sender: Sender;
  },
) {
  const { report, abandon } = deps;
  const { canSendNow, keep, dispatch, drainSends } = deps.sender;

  /**
   * TAKE WHATEVER THE RECORDER HAS WRITTEN SINCE LAST TIME, AND SEND IT.
   *
   * The continuous replacement for a rotation. Nothing here stops, restarts or
   * touches the device: it reads the file the recorder is writing into, cuts
   * the new bytes off at a sample boundary, wraps them in a WAVE header and
   * hands them over. `record()` is never called, which is the property that
   * makes a locked phone go on recording.
   *
   * ## It advances on what it actually took, not on what it hoped for
   *
   * The rotating path charges `SEGMENT_MS` to the offset because a rotation
   * really is one interval of audio. Here the recorder's buffer decides how
   * much exists at any moment, so the duration is computed from the bytes —
   * `pcmDurationMs` — and the offset moves by exactly that. A tick that finds
   * eighteen seconds on disk sends eighteen and the other two go next time,
   * with every timestamp still landing where the sound did.
   *
   * ## Nothing is dropped when the sends are backed up, or when there are none
   *
   * Every slice goes into the spool before anything else is decided, so a tick
   * with no connection, or three sends already out, still cuts its twenty
   * seconds and keeps them. Only a spool that refuses the write brings back the
   * older rule — **the file is the buffer**: do not advance, and let the next
   * tick take the bytes.
   *
   * @param ceilingMs The most audio one slice may carry. See `MAX_SLICE_MS`.
   * @returns Whether a slice was sent, so a drain can loop until it is not.
   */
  function sliceOnce(ceilingMs: number): boolean {
    const active = rec.device;
    if (active === null) return false;
    const uri = active.uri;
    if (uri === null) return false;

    let file: File;
    try {
      file = new File(uri);
    } catch {
      return false;
    }
    const size = file.size;
    if (size <= 0) return false;

    if (rec.pcmFormat === null) {
      /*
        Read once and kept. A header that is not there yet — the recorder has
        opened the file and not flushed — is the ordinary first tick of a
        meeting, so it is a quiet `false` and not a report: telling somebody
        their microphone failed because a buffer had not landed would be the
        crying-wolf half of the honesty this module is otherwise built on.
      */
      const head = readRange(file, 0, Math.min(size, WAV_HEADER_SCAN_BYTES));
      if (head === null) return false;
      const parsed = parseWavHeader(head);
      if (parsed === null) return false;
      rec.pcmFormat = parsed;
      rec.pcmRead = parsed.dataOffset;
    }

    const available = alignToFrame(size - rec.pcmRead, rec.pcmFormat);
    if (available <= 0) return false;

    const take = Math.min(available, pcmBytesForMs(ceilingMs, rec.pcmFormat));
    if (take <= 0) return false;

    const pcm = readRange(file, rec.pcmRead, take);
    if (pcm === null) return false;

    /*
      INTO THE SPOOL FIRST, WHATEVER HAPPENS NEXT.

      A slice that is kept can be cut whether or not it can be sent: offline,
      or with the sends backed up, it simply waits on the device. Only when the
      spool refuses it — a full disk — does the old rule come back: the file is
      the buffer, so leave the bytes where they are rather than cut audio there
      is nowhere to put.
    */
    const offsetMs = rec.chunkStartOffsetMs;
    const durationMs = pcmDurationMs(pcm.length, rec.pcmFormat);
    const wav = wavFile(pcm, rec.pcmFormat);
    const kept = keep(
      { meetingId: rec.sessionKey, index: rec.chunkIndex, offsetMs, durationMs },
      { kind: "bytes", bytes: wav, mimeType: WAV_MIME },
    );
    if (kept === null && !canSendNow()) return false;

    /*
      The offset moves before the send, exactly as `closeChunk`'s does and for
      the same reason: these bytes have been taken, and a send that fails must
      not make the rest of the meeting's timestamps early. A failed slice that
      was kept is a delay; one that could not be kept is a gap — never a shift.
    */
    rec.chunkStartOffsetMs += durationMs;
    rec.pcmRead += pcm.length;
    rec.chunkStartedAtMs = Date.now();

    const chunkId = chunkIdFor(rec.sessionKey, rec.chunkIndex);
    rec.chunkIndex += 1;
    if (kept === null) {
      dispatch({ base64: encodeBase64(wav), mimeType: WAV_MIME }, chunkId, offsetMs, durationMs);
      return true;
    }
    if (canSendNow()) {
      dispatch({ spooled: kept, base64: encodeBase64(wav) }, chunkId, offsetMs, durationMs);
    }
    return true;
  }

  /**
   * Every slice still on disk, for the end of a meeting.
   *
   * With the spool working, `sliceOnce` never refuses for want of a send, so
   * this cuts the rest of the recording into the spool and returns — and the
   * chunks that did not go out now go through the drain. The wait below is for
   * the case the spool could not take a slice: then `sliceOnce` refuses while
   * the sends are backed up, and a single call at `stop()` could leave the last
   * minute of a meeting in a file that is about to be deleted. So it waits the
   * backlog out rather than dropping it: the audio exists, and `stop()`'s own
   * comment already accepts that the wait costs a spinner rather than a
   * microphone.
   */
  async function sliceAll(): Promise<void> {
    if (await abandonIfNowhereToSend()) return;
    for (;;) {
      if (sliceOnce(MAX_SLICE_MS)) continue;
      /*
        NOTHING WENT OUT, AND THE TWO REASONS FOR THAT WANT OPPOSITE THINGS.

        **The file is fully cut** — every byte is either sent or in flight — and
        this is done. It returns *without* waiting for the answers, which is the
        difference between "the audio is off the device" and "the meeting has
        been transcribed". Only the first is this function's job, and confusing
        them is what made ending a meeting take as long as Whisper did:
        `stop()` did not return, so the controller could not fold the `end`,
        so the live screen stayed up with its clock running while the person
        waited on a network round trip. The wait still happens — `drain()` is
        where — but it happens after the meeting has visibly ended.

        **The queue is full**, and then waiting is exactly the point: the bytes
        stay on the file and the next pass takes them. Bounded at
        `MAX_INFLIGHT_CHUNKS` slices in memory at a time, which is what keeps a
        long backlog from being cut into the heap all at once.

        Told apart by re-reading the file rather than by the queue, because
        "no slice went out" means both and only the file knows which.
      */
      if (!hasUncutAudio()) return;
      if (rec.inFlight.size === 0) return;
      await drainSends();
    }
  }

  /**
   * Whether the recording still holds at least one whole sample frame nobody
   * has taken.
   *
   * The terminator for `sliceAll`, and deliberately the same arithmetic
   * `sliceOnce` uses to decide what it can take — a different rounding here
   * would either spin on a half sample forever or return with audio still on a
   * file that is about to be deleted.
   */
  function hasUncutAudio(): boolean {
    const active = rec.device;
    if (active === null || rec.pcmFormat === null) return false;
    const uri = active.uri;
    if (uri === null) return false;
    try {
      return alignToFrame(new File(uri).size - rec.pcmRead, rec.pcmFormat) > 0;
    } catch {
      return false;
    }
  }

  /**
   * WITH NOWHERE TO SEND, THE MICROPHONE GOES BACK — ON THIS PATH TOO.
   *
   * `closeChunk` has made this check since a meeting was found recording for
   * nobody: no transcriber means nothing will ever read these bytes, so
   * holding the input *"is the shape this feature exists to make impossible"*.
   * Its own check sits below the continuous branch, which returns before
   * reaching it — so a first version of this change quietly recorded an
   * uncapped WAVE file, for the length of a meeting, behind a live indicator,
   * transcribing none of it. Found by reading the diff rather than by a test,
   * which is why the test below now exists.
   *
   * Asked once per tick rather than once per chunk, which is the same question
   * at the same rate: the transcriber is installed for the life of a session
   * and either resolves or does not.
   *
   * @returns Whether capture was given up, so the caller stops.
   */
  async function abandonIfNowhereToSend(): Promise<boolean> {
    if (resolveTranscriber() !== null) return false;
    await abandon(NO_TRANSCRIBER);
    return true;
  }

  /**
   * Close the open file and hand it over. Never waits for the answer.
   *
   * `durationMs` is the caller's rather than a clock reading, because that is
   * what makes the offsets arithmetic: a full rotation contributes exactly
   * `SEGMENT_MS`, and only the partial chunk at a pause or an end measures.
   *
   * The order below is the load-bearing part. **The clock moves first, and it
   * moves whatever happens next**: `durationMs` of session time really did
   * pass, so every later chunk starts that much further along, and a device
   * that will not close must not make the rest of the meeting's timestamps
   * early. **The id is spent last**, only when there is a request to carry it,
   * so a chunk that contributed nothing leaves no gap in the sequence.
   */
  async function closeChunk(durationMs: number): Promise<void> {
    const active = rec.device;
    if (active === null) return;

    /*
      A CONTINUOUS RECORDER HAS NO CHUNK TO CLOSE, ONLY AUDIO NOT YET TAKEN.

      Every caller of this function means the same thing — *that is the end of a
      piece of audio, send it* — and on this path that is `sliceAll`: take what
      is on disk and leave the device alone. `durationMs` is ignored on purpose
      rather than applied to the offset, because the slicer derives the real
      duration from the bytes it took, and adding a caller's estimate on top
      would double-count every pause and every interruption.

      The device is not stopped here. `stop`, `pause` and the interruption path
      each release or replace it themselves, and doing it here would put a
      `record()` back on the rotation tick — the one call this whole change
      exists to stop making.
    */
    if (rec.continuous) {
      /*
        THE DEVICE IS STOPPED BEFORE A BYTE IS TAKEN, AND THAT ORDER IS THE FIX.

        The first version of this branch sliced while the recorder went on
        writing, and the comment on `stop()` below — *"the device is already
        back, so waiting here costs a spinner rather than a microphone"* — was
        left standing when it had stopped being true. On this path the device is
        released *after* `closeChunk`, so every second the drain spent waiting
        for a transcription was a second the microphone was still open, on a
        meeting somebody had finished. The owner saw it: *"it keeps recording
        while it's processing"*.

        It was also a tail-chase. `sliceAll` cuts what is on the file, and a
        recorder that is still running puts another 32 KB a second on it — so
        each pass found the audio recorded during the previous pass's wait, and
        the drain converged only because sending happens to be faster than
        recording.

        Stopping first closes both: the input is released at the moment the
        person pressed End, and the file is a fixed size, so what is left to cut
        is bounded by what the ticks had not taken.
      */
      await active.stop().catch(() => {
        // A recorder that will not stop is not a reason to abandon the audio
        // it has already written. `releaseDevice` tries again and reports.
      });
      await sliceAll();
      return;
    }

    const offsetMs = rec.chunkStartOffsetMs;
    rec.chunkStartOffsetMs += durationMs;

    let closed = true;
    try {
      await active.stop();
    } catch {
      closed = false;
    }

    const uri = active.uri;
    if (uri === null) return;
    const file = new File(uri);

    /*
      Every exit from here owns the file. `send` deletes the one it is given;
      everything else deletes it right here. The path that did not — a `stop()`
      that threw, so `uri` was never read — left the `.m4a` in the cache with
      nothing left in the process that knew about it.
    */
    if (!closed || durationMs <= 0) {
      discard(file.uri);
      if (!closed) report({ recoverable: true, message: CHUNK_FAILED });
      return;
    }

    if (resolveTranscriber() === null) {
      /*
        `recoverable: false` is documented as "the session is notes-only from
        here", and this used to say it every twenty seconds while going on
        holding the microphone and rotating chunks it deleted unread. Recording
        somebody's meeting in order to throw it away, behind a live indicator,
        is the shape this feature exists to make impossible — so the report is
        made true rather than repeated.
      */
      discard(file.uri);
      await abandon(NO_TRANSCRIBER);
      return;
    }

    /*
      KEPT, THEN SENT IF IT CAN BE.

      The finished recording is moved into the spool, where it stays until its
      words are delivered. Offline, or with `MAX_INFLIGHT_CHUNKS` already out,
      that is all that happens now: it waits, and the drain sends it. This is
      where a chunk used to be *dropped* — "a backlog is dropped rather than
      kept" — and the reversal is the point of the spool.
    */
    const kept = keep(
      { meetingId: rec.sessionKey, index: rec.chunkIndex, offsetMs, durationMs },
      { kind: "file", uri: file.uri, mimeType: CHUNK_MIME },
    );
    if (kept !== null) {
      const chunkId = chunkIdFor(rec.sessionKey, rec.chunkIndex);
      rec.chunkIndex += 1;
      if (canSendNow()) dispatch({ spooled: kept, base64: null }, chunkId, offsetMs, durationMs);
      return;
    }

    /*
      The spool would not take it — a full disk. What is left is the rule that
      predates the spool, because there is nowhere to keep the file: send it
      once if there is room, and drop it with a sentence if there is not.
    */
    if (rec.inFlight.size >= MAX_INFLIGHT_CHUNKS) {
      discard(file.uri);
      report({ recoverable: true, message: SEND_BACKLOG });
      return;
    }

    dispatch(file, chunkIdFor(rec.sessionKey, rec.chunkIndex), offsetMs, durationMs);
    rec.chunkIndex += 1;
  }

  return { sliceOnce, closeChunk, abandonIfNowhereToSend };
}

export type Chunks = ReturnType<typeof createChunks>;
