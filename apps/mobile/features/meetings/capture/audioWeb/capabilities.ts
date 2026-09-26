import { METER_FLOOR_DB } from "../level";

/**
 * What a browser can hear and can be asked for, probed rather than assumed.
 *
 * Split out of `audio.web.ts`: everything here answers a yes/no question about
 * the environment (can it record at all, can it share a tab's audio, can it
 * build a Web Audio graph to mix and meter two inputs) rather than driving a
 * recording in progress. `mediaRecorderRecorder` in `recorder.ts` is the only
 * caller.
 */

/**
 * All three halves of the capability, probed rather than assumed.
 *
 * A browser missing any of them is answered by `notesOnlyRecorder("web")` with
 * its own sentence — an absent capability is reported, never faked, and never
 * turned into a `start()` that throws at the person mid-press.
 *
 * `Blob.prototype.arrayBuffer` is the third one and it is here rather than
 * discovered halfway through a meeting: without it there is no way to get bytes
 * out of a recording, so the recorder would capture happily and send nothing.
 * In practice every browser that can record has it — `arrayBuffer()` predates
 * `MediaRecorder`'s Safari support by years — which is exactly why asking is
 * cheap and assuming is the kind of thing that is only wrong on one browser.
 */
export function browserCanRecord(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") return false;
  if (typeof MediaRecorder === "undefined") return false;
  return typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer === "function";
}

/**
 * Whether this browser could, with the person's help, hear the call as well.
 *
 * Both halves, and the second is the one that is easy to forget: a picker with
 * nothing to mix its audio *into* is a share that holds a tab hostage and
 * records the microphone anyway. `createMediaStreamDestination` is how two
 * inputs become one recording, so a browser without it cannot offer this at all
 * and says so by not drawing the switch.
 *
 * What this probe **cannot** tell you is whether the browser will actually
 * hand over audio — Firefox has `getDisplayMedia` and shares no audio from it,
 * and every browser refuses audio for some sources and not others. There is no
 * API that answers that in advance, which is why the offer is worded as a
 * request and every empty answer is reported rather than assumed away. An
 * absent capability is still never faked: what is claimed here is *"this
 * browser can ask"*, which is true.
 */
export function browserCanShareSystemAudio(): boolean {
  if (typeof navigator === "undefined") return false;
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return false;
  if (!browserSharesDisplayAudio()) return false;
  if (typeof AudioContext === "undefined") return false;
  return typeof AudioContext.prototype?.createMediaStreamDestination === "function";
}

/**
 * Whether this browser's picker can hand over audio at all.
 *
 * Firefox and Safari have `getDisplayMedia` and never share audio from it, so
 * on them the offer is a picker in front of every meeting that cannot produce
 * the thing it asks for. That was tolerable while the offer was off by default;
 * with it on (`machineAudio.ts`) it would be a prompt per meeting for nothing.
 *
 * `suppressLocalAudioPlayback` is a constraint that only means anything on a
 * captured display's **audio** track, and the browsers that share display
 * audio are the ones that list it. It is a proxy rather than a promise — even
 * Chrome refuses audio for some sources — which is why an empty share is still
 * reported rather than assumed away.
 */
function browserSharesDisplayAudio(): boolean {
  try {
    const supported = navigator.mediaDevices.getSupportedConstraints?.() as
      | Record<string, unknown>
      | undefined;
    return supported?.suppressLocalAudioPlayback === true;
  } catch {
    return false;
  }
}

/** What the picker is asked for: the audio, and the least video it will take. */
const DISPLAY_CONSTRAINTS = {
  audio: true,
  /*
    `video` is not optional — every implementation refuses `getDisplayMedia`
    with audio alone — and the track it hands back cannot simply be stopped
    either, because stopping it ends the share and takes the audio with it. So
    it is asked for as small and as slow as a constraint can make it, kept
    alive, and never rendered or recorded: `MediaRecorder` is given the mixed
    **audio** destination, not this stream.
  */
  video: { frameRate: 1, width: 1, height: 1 },
  /*
    Hints, which a browser that does not know them ignores. `systemAudio`
    lets Chrome offer the machine's audio for a whole screen too (Windows and
    ChromeOS can), and `selfBrowserSurface` keeps this tab out of the list:
    sharing the app's own tab is the easiest wrong answer, and it carries none
    of the call.
  */
  systemAudio: "include",
  selfBrowserSurface: "exclude",
} as const;

/**
 * The analyser's window: 2048 samples, which is ~43ms at 48kHz.
 *
 * Long enough that one RMS reading is a syllable rather than a zero-crossing,
 * short enough that the mark moves with a voice rather than lagging it.
 */
const LEVEL_FFT_SIZE = 2048;

/**
 * The Web Audio graph this capture is running, or `null` for none.
 *
 * `mixed` is non-null **only** when there are genuinely two inputs to combine.
 * A microphone-only meeting records `getUserMedia`'s own stream exactly as it
 * always did — the bytes `MediaRecorder` sees do not change because a meter was
 * added — and the analyser hangs off the side of it.
 */
export interface AudioGraph {
  context: AudioContext;
  analyser: AnalyserNode | null;
  mixed: MediaStream | null;
}

/**
 * Ask the person for a source, and hand back only one that carries audio.
 *
 * `null` for every way this comes back empty, because the caller says the same
 * sentence for all of them. The two that are not obvious:
 *
 *  - **A rejection is ordinary.** Cancelling the picker is a `NotAllowedError`,
 *    and so is a browser that will not share audio at all, and so is a lapsed
 *    transient activation. None of them is a fault worth its own words.
 *  - **A resolved share with no audio track is the common miss.** Chrome hands
 *    back a video-only stream when the "share audio" box is left unticked, and
 *    when a whole screen is picked on a platform that cannot loop it back. Kept,
 *    it would hold a tab captured for a recording it contributes nothing to, so
 *    it is stopped here — including the video track, which is what actually
 *    ends the share and turns the browser's sharing bar off.
 */
export async function shareSystemAudio(): Promise<MediaStream | null> {
  let shared: MediaStream;
  try {
    shared = await navigator.mediaDevices.getDisplayMedia(DISPLAY_CONSTRAINTS);
  } catch {
    return null;
  }
  if (shared.getAudioTracks().length === 0) {
    for (const track of shared.getTracks()) track.stop();
    return null;
  }
  return shared;
}

/**
 * The Web Audio graph for this capture: a meter always, a mixer when needed.
 *
 * `null` for a browser with no usable `AudioContext`, which costs the meter and
 * — because `mixed` comes from the same graph — costs the share as well. Both
 * absences are reported by their own callers rather than papered over.
 *
 * ## Nothing is connected to `context.destination`, ever
 *
 * That is the speakers. Connecting a shared tab's audio to them plays the call
 * back into the room the microphone is in, which is a feedback loop on a
 * recording, and connecting the microphone to them is the same loop with the
 * inputs swapped. The analyser and the mixing destination are both sinks that
 * pull without playing, which is exactly what is wanted here.
 *
 * ## A suspended context is a silent recording, so it is checked
 *
 * Autoplay policy can hand back a context in `suspended`, and a suspended
 * context's `MediaStreamAudioDestinationNode` produces a stream of silence —
 * a meeting that records perfectly and contains nothing. `resume()` is the fix
 * and the state check after it is the guard: a context that will not run is
 * closed and answered as `null`, so the caller falls back to recording the
 * microphone's own stream rather than a silent mix of it.
 */
export async function buildGraph(
  mic: MediaStream,
  display: MediaStream | null,
): Promise<AudioGraph | null> {
  if (typeof AudioContext === "undefined") return null;
  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return null;
  }
  try {
    if (context.state === "suspended") await context.resume();
  } catch {
    // The state check below is what decides; a rejected resume is one way of
    // arriving at it and not a separate outcome.
  }
  if (context.state !== "running") {
    void context.close().catch(() => {});
    return null;
  }
  try {
    const sources = [context.createMediaStreamSource(mic)];
    if (display !== null) sources.push(context.createMediaStreamSource(display));

    let mixed: MediaStream | null = null;
    if (display !== null) {
      const destination = context.createMediaStreamDestination();
      for (const source of sources) source.connect(destination);
      mixed = destination.stream;
    }

    /*
      One analyser fed by every input, rather than one per input and `loudest`
      over the pair. The bridge carries two numbers because the shell genuinely
      knows both and a diagnostics screen may want the split; here the two
      inputs are already being summed into one recording, and the question the
      mark answers — *"can this hear anything"* — is a question about that
      recording. A browser with no `getFloatTimeDomainData` has no meter, which
      is `null` rather than a zero, for the reason `capture/level.ts` gives.
    */
    const analyser = context.createAnalyser();
    analyser.fftSize = LEVEL_FFT_SIZE;
    for (const source of sources) source.connect(analyser);
    const usable = typeof analyser.getFloatTimeDomainData === "function";

    return { context, analyser: usable ? analyser : null, mixed };
  } catch {
    void context.close().catch(() => {});
    return null;
  }
}

/**
 * One window of samples as dBFS, on the scale `meterLevel` maps.
 *
 * RMS rather than peak, because `meterLevel`'s floor was calibrated against
 * `AVAudioRecorder.averagePower` on the phone and a peak reading against an
 * average's scale would sit a mark high all meeting.
 *
 * A window of exact zeros is digital silence, and `20 * log10(0)` is
 * `-Infinity`, which `meterLevel` reads as *"no reading"* — the one answer it
 * must not be, because something genuinely is listening. It is returned as the
 * floor instead, which is the bottom of the mark rather than the absence of one.
 */
export function rmsDbfs(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (!(rms > 0)) return METER_FLOOR_DB;
  return 20 * Math.log10(rms);
}
