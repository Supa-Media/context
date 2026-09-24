import { RecordingPresets } from "expo-audio";
import type { File } from "expo-file-system";
import { SEGMENT_MS } from "../segments";
import type { SpooledChunk } from "../spool";
import { PCM_BIT_DEPTH, PCM_CHANNELS, PCM_SAMPLE_RATE } from "../wav";

/**
 * AAC in an MPEG-4 container — `RecordingPresets.HIGH_QUALITY` writes `.m4a` on
 * iOS. `audio/mp4` is that file's real media type; it is passed through to the
 * transcriber so the service names the upload correctly rather than sniffing.
 *
 * **iOS no longer uses it.** See `PCM_RECORDING_OPTIONS`: a `.m4a` that is
 * still being written cannot be read, and reading one while it is written is
 * the whole of the fix for meetings that ended at the lock screen. It stays for
 * Android, which has no linear-PCM recorder to switch to.
 */
export const CHUNK_MIME = "audio/mp4";

/**
 * WHAT iOS RECORDS INTO NOW, AND WHY IT IS UNCOMPRESSED.
 *
 * `RecordingPresets.HIGH_QUALITY` writes AAC into an MPEG-4 container, which is
 * the right choice for a file somebody keeps and the wrong one for a file
 * somebody reads while it is being written: an `.m4a` is not valid until
 * `stop()` writes its `moov` atom, so a prefix of one is not a shorter
 * recording, it is not a recording.
 *
 * That mattered the moment the rotation had to go. iOS refuses to *start* a
 * recording from the background — `AVAudioSessionErrorCodeCannotStartRecording`
 * — while letting one that is already running continue, so a recorder that
 * stops and restarts every twenty seconds hands back the one thing it is
 * allowed to keep and is refused it. Locking the phone ended the meeting on the
 * next tick. `wav.ts` carries the full argument and the citation.
 *
 * So the recorder is started once and the chunks are cut out of the file it
 * goes on writing, which needs a format whose bytes on disk are the audio so
 * far. Linear PCM in a WAVE container is that format.
 *
 * **16 kHz mono, which is smaller than it sounds and better than it looks.**
 * Uncompressed costs about 115 MB an hour against roughly 8 MB for AAC, in a
 * cache directory, for the length of one meeting. What it buys back: 16 kHz
 * mono is the transcription model's own input, so nothing resamples later, and
 * a meeting recorder that survives a lock screen is the feature.
 *
 * Nothing downstream is asked to trust these numbers — `parseWavHeader` reads
 * the format out of the file the device actually produced, because a device may
 * substitute a rate and a slice labelled with the wrong one transcribes as
 * nonsense.
 */
/**
 * **FLAT, AND THAT IS NOT A STYLE CHOICE.**
 *
 * `RecordingPresets` are nested — common fields at the top, then `ios`,
 * `android` and `web` sub-objects — and `expo-audio`'s own `useAudioRecorder`
 * flattens the right one into the common fields before constructing a
 * recorder (`createRecordingOptions` in its `utils/options`). That helper is
 * not exported, and this module has never used the hook: it constructs
 * `AudioModule.AudioRecorder` directly, because a recording has to outlive the
 * screen that started it.
 *
 * The native side decodes **one flat record** — `extension`, `sampleRate`,
 * `numberOfChannels`, `bitRate`, `outputFormat`, `audioQuality`, the
 * `linearPCM*` trio — and ignores keys it does not know. So a nested preset
 * handed straight to the constructor delivers the four common fields and
 * silently drops everything under `ios`.
 *
 * That has been true of `RecordingPresets.HIGH_QUALITY` here since this file
 * was written and cost nothing, because `.m4a` plus CoreAudio's defaults is
 * AAC anyway — which is exactly why nobody noticed. It would not be free here:
 * `outputFormat` is the field that selects linear PCM, and dropping it would
 * produce a `.wav` extension over an AAC payload, whose growing bytes are
 * unreadable in precisely the way this whole change exists to stop. The
 * recording would look right in every log and transcribe as nothing.
 *
 * So this object is written the way the native record is read.
 */
export const PCM_RECORDING_OPTIONS = Object.freeze({
  extension: ".wav",
  sampleRate: PCM_SAMPLE_RATE,
  numberOfChannels: PCM_CHANNELS,
  /*
    Meaningless for linear PCM — there is no encoder to give a budget to — and
    sent because the native record requires the field. The real size is the
    rate times the channels times the depth, which is 32 KB a second.
  */
  bitRate: PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BIT_DEPTH,
  /*
    `IOSOutputFormat.LINEARPCM`, spelled as the four-character code the native
    side turns it into rather than imported as an enum for one value that has
    been `"lpcm"` for as long as CoreAudio has existed.
  */
  outputFormat: "lpcm",
  /** `AudioQuality.MAX`, and equally decorative for an uncompressed format. */
  audioQuality: 127,
  linearPCMBitDepth: PCM_BIT_DEPTH,
  linearPCMIsBigEndian: false,
  linearPCMIsFloat: false,
  /*
    The meter. `AVAudioRecorder.averagePower` is only updated for a recorder
    that was asked for it, and nothing asked — so `useAudioLevel` answered
    `null` on every phone and the mark beside the clock drew its static
    silhouette for the length of every meeting. See `LEVEL_INTERVAL_MS`.
  */
  isMeteringEnabled: true,
});

/**
 * Android's preset, plus the one flat key that turns its meter on.
 *
 * `isMeteringEnabled` at the top level, which is where the native record reads
 * every field from — the flattening trap `PCM_RECORDING_OPTIONS` documents,
 * used deliberately this time. Nothing else about the recording changes: the
 * format fields under `android:` are ignored exactly as they always have been,
 * so this adds a meter without touching what Android records.
 */
export const ANDROID_RECORDING_OPTIONS = Object.freeze({
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
});

/**
 * How much audio one slice may carry, as a multiple of the tick.
 *
 * A slice is sent every `SEGMENT_MS`, so one tick's worth is the normal case
 * and the headroom is for catching up: a tick that ran late, or a device that
 * flushed its buffer in a burst, leaves more than one interval of audio on
 * disk. **The file is the buffer** — bytes not taken this tick are still there
 * on the next one, which is the property the rotating recorder never had — so
 * this is a ceiling on one request rather than a limit on what survives.
 *
 * The ceiling exists because the gateway bounds a transcribe body at
 * `LIMITS.transcribeBodyChars` (1,404,096 characters of base64). Thirty seconds
 * of 16 kHz mono 16-bit is 960,000 bytes, which is 1,280,000 characters
 * encoded: inside the limit with room for the envelope around it.
 */
export const MAX_SLICE_MS = SEGMENT_MS * 1.5;

/**
 * What a send carries, which is one of two things with one difference.
 *
 * A **rotated chunk** is a file: the recorder finished it, the send reads it
 * and deletes it, and until it does `inFlightUris` keeps `releaseDevice` from
 * deleting it first. A **continuous slice** is bytes already in memory, cut out
 * of a recording that is still going and that this send does not own.
 *
 * Kept as one union rather than two send paths because the difference is
 * ownership and nothing else — the request, the retry, the reporting and the
 * backlog rule are identical — and a second copy of those is how the two
 * platforms would drift.
 */
export type Payload =
  | File
  | { base64: string; mimeType: string }
  /**
   * A chunk already in the spool. It owns no file the device knows about — the
   * spool does — and the send confirms it only once its words are delivered.
   * `base64` is carried when the bytes are already in memory, so a slice that
   * was just written is not read straight back off the disk.
   */
  | { spooled: SpooledChunk; base64: string | null };
