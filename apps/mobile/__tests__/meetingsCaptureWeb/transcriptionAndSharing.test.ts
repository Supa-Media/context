/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { CAPTURE_MESSAGES, audioRecorder } from "../../features/meetings/capture/audio.web";
import { SEGMENT_MS } from "../../features/meetings/capture/segments";
import {
  FakeStream,
  FakeStreamDestination,
  type PickerAnswer,
  advance,
  harness,
  installAudioContext,
  installGetUserMedia,
  installSharing,
  recordedStream,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * A chunk nobody spoke in, and the whole call where a browser can ask for it:
 * the share picker, the audio mix, and the difference between asking and
 * getting. See `fixtures.ts` for the fake browser this suite installs and the
 * sabotage record that proves it.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

/**
 * The browser recorder and the phone's send the same chunks to the same worker,
 * so they say the same thing about a chunk nobody spoke in — and this is the
 * check that keeps the two from drifting apart.
 *
 * The worker refuses the segments the engine's own evidence says are not
 * speech, after ninety seconds of a quiet room produced 166 words and filed
 * them into a bucket. A quiet chunk therefore comes back empty, which on the
 * glass looks exactly like a transcriber that has stopped working, so the
 * recorder says which. All three directions, because each wrong answer is a
 * different lie: see `meetingsCapture.test.ts` for the argument in full.
 */
describe("a chunk nobody spoke in", () => {
  test("is said out loud, in a sentence from the closed set", async () => {
    const { recorder, transcriber, errors } = harness();
    transcriber.refusedNextTime(2);
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(errors[0].message).toMatch(/no speech was heard/i);
    expect(CAPTURE_MESSAGES).toContain(errors[0].message);
    await recorder.stop();
  });

  test("...but an empty answer with nothing refused says nothing", async () => {
    const { recorder, errors } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(errors).toHaveLength(0);
    await recorder.stop();
  });
});

/* -------------------------------------------------------------------------- */
/*                     the whole call, in a browser                           */
/* -------------------------------------------------------------------------- */

/**
 * A browser cannot tap the machine's output. It can ask the person for a source
 * and mix that source's audio into the recording, which is a real answer to
 * "the far side of my call is on headphones" — and a different thing to agree
 * to from the shell's silent loopback tap.
 *
 * Everything here is about the difference between *asking* and *getting*.
 * `getDisplayMedia` resolving is not a source with audio on it, a source with
 * audio on it is not a recording of both sides, and none of the three misses
 * may look like success. The claim a recorder makes is the thing this suite
 * guards: `capability.systemAudio` must not be true where nothing behind it
 * could honour the switch, and a mic-only recording must never be presented as
 * a recording of a call.
 */
describe("the whole call, where a browser can ask for it", () => {
  test("both halves of the probe, or no offer at all", () => {
    // Neither: jsdom's own browser, and the default for every test above.
    expect(audioRecorder("web").capability.systemAudio).toBe(false);

    // A picker with nothing to mix its audio into would hold a tab captured and
    // record the microphone anyway, so half the probe is no offer.
    installGetUserMedia(true);
    expect(audioRecorder("web").capability.systemAudio).toBe(false);

    // ...and Web Audio with no picker has nothing to mix.
    installGetUserMedia();
    installAudioContext();
    expect(audioRecorder("web").capability.systemAudio).toBe(false);

    installSharing();
    const capability = audioRecorder("web").capability;
    expect(capability.systemAudio).toBe(true);
    /*
      The second field, and the reason it exists: the sheet has to say a picker
      is coming. Claiming the shell's silent switch here would be an offer to do
      something without asking, on the one surface that cannot.
    */
    expect(capability.systemAudioNeedsPicker).toBe(true);
  });

  /**
   * THE PICKER GOES FIRST, AND THIS IS THE CHECK THAT KEEPS IT THERE.
   *
   * `getDisplayMedia` needs transient activation and `getUserMedia` does not. A
   * microphone prompt sitting on screen while somebody finds Allow spends the
   * activation the picker needs, so the share would be refused for a reason
   * that has nothing to do with what anybody chose — and the person would be
   * told their call is not being recorded because they granted a microphone.
   */
  test("the picker is opened before the microphone prompt", async () => {
    installSharing();
    const { recorder } = harness({ systemAudio: true });
    await recorder.start();
    expect(webState.prompts).toEqual(["picker", "microphone"]);
    await recorder.stop();
  });

  test("nobody is asked to share anything unless they asked for it", async () => {
    installSharing();
    const { recorder } = harness({ systemAudio: false });
    await recorder.start();
    expect(webState.prompts).toEqual(["microphone"]);
    await recorder.stop();
  });

  test("a shared source is mixed with the microphone, and the mix is what records", async () => {
    installSharing();
    const { recorder } = harness({ systemAudio: true });
    await recorder.start();

    const context = webState.contexts[0];
    expect(context).toBeDefined();
    // Both inputs reached the graph, and the recorder was handed the mix rather
    // than either half of it.
    expect(context.sourced).toHaveLength(2);
    expect(recordedStream()).toBe("mix");
    /*
      AND THE PICTURE IS NEVER RECORDED, WHICH IS A PROMISE THE SHEET MAKES.

      The picker is a *screen* picker and there is no way to ask it for audio
      alone, so a video track genuinely is handed over. What is recorded is the
      mixing destination's stream, which carries audio and nothing else —
      somebody sharing the tab a private conversation is in is entitled to that.
    */
    const recorded = webState.instances[0]?.source as FakeStream;
    expect(recorded.getTracks().some((track) => track.kind === "video")).toBe(false);
    expect(webState.displayTracks.some((track) => track.kind === "video")).toBe(true);
    await recorder.stop();
  });

  /**
   * Nothing is ever connected to `context.destination`, which is the speakers.
   *
   * Playing a shared tab back into the room the microphone is in is a feedback
   * loop on somebody's recording, and the fake has no `destination` property at
   * all — so a version of `buildGraph` that reached for one would throw and be
   * caught, and the assertion below is what turns that into a visible failure
   * rather than a silently mic-only meeting.
   */
  test("the call's audio is never played back into the room", async () => {
    installSharing();
    const { recorder } = harness({ systemAudio: true });
    await recorder.start();
    expect(webState.contexts[0]?.destination).toBeInstanceOf(FakeStreamDestination);
    expect(recordedStream()).toBe("mix");
    await recorder.stop();
  });

  test.each([
    ["the picker was cancelled", "cancelled" as PickerAnswer],
    ["the source shared carries no audio", "silent" as PickerAnswer],
  ])("%s: a microphone recording, and a sentence saying so", async (_name, answer) => {
    installSharing(answer);
    const { recorder, errors } = harness({ systemAudio: true });
    await recorder.start();

    // The meeting runs. The microphone half is fine and it is the *claim* that
    // would have been wrong, which is why this is recoverable.
    expect(recorder.state).toBe("recording");
    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(errors[0].message).toMatch(/only your microphone/i);
    expect(CAPTURE_MESSAGES).toContain(errors[0].message);
    await recorder.stop();
  });

  /**
   * A share with no audio on it is handed straight back.
   *
   * Kept, it would hold a tab captured and the browser's sharing bar lit for a
   * recording it contributes nothing to — the worst of both: somebody watching
   * a "sharing" indicator while their call is not in the transcript.
   */
  test("a source with no audio is let go rather than held", async () => {
    installSharing("silent");
    const { recorder } = harness({ systemAudio: true });
    await recorder.start();
    expect(webState.displayTracks.every((track) => track.stopped)).toBe(true);
    await recorder.stop();
  });

  test("a browser that cannot mix records the microphone and says so", async () => {
    /*
      Web Audio present enough to pass the probe, and refusing to run: autoplay
      policy hands back a suspended context, and a suspended context's
      destination produces a stream of silence — a meeting that records
      perfectly and contains nothing.
    */
    installSharing();
    webState.contextStartsSuspended = true;
    webState.contextRefusesToResume = true;
    const { recorder, errors } = harness({ systemAudio: true });
    await recorder.start();

    expect(recordedStream()).toBe("microphone");
    expect(errors.map((error) => error.message)).toEqual([
      expect.stringMatching(/only your microphone/i),
    ]);
    expect(webState.displayTracks.every((track) => track.stopped)).toBe(true);
    await recorder.stop();
  });

  test("a context that only needed waking is used", async () => {
    installSharing();
    webState.contextStartsSuspended = true;
    const { recorder, errors } = harness({ systemAudio: true });
    await recorder.start();
    expect(recordedStream()).toBe("mix");
    expect(errors).toHaveLength(0);
    await recorder.stop();
  });

  /**
   * "Stop sharing" is a button about a *screen*, and the cost of pressing it
   * here is half the call. The recording carries on — the microphone is still
   * open and the mix is still what `MediaRecorder` holds — so this is a
   * sentence rather than a failure, and the sentence says what was and was not
   * captured.
   */
  test("a share stopped mid-meeting is said out loud, and the rest is recorded", async () => {
    installSharing();
    const { recorder, errors } = harness({ systemAudio: true });
    await recorder.start();
    expect(errors).toHaveLength(0);

    webState.displayTracks.find((track) => track.kind === "audio")?.end();

    expect(recorder.state).toBe("recording");
    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(errors[0].message).toMatch(/sharing stopped/i);
    expect(CAPTURE_MESSAGES).toContain(errors[0].message);
    // The video track is the one that actually ends the share, and nothing else
    // will release it now that `releaseStream` has lost its handle on it.
    expect(webState.displayTracks.every((track) => track.stopped)).toBe(true);
    await recorder.stop();
  });

  test("ending a meeting turns the sharing indicator off as well as the recording one", async () => {
    installSharing();
    const { recorder } = harness({ systemAudio: true });
    await recorder.start();
    await recorder.stop();

    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
    expect(webState.displayTracks.every((track) => track.stopped)).toBe(true);
    // An `AudioContext` is a hardware resource with a small per-page limit, and
    // a page that opens one per meeting and closes none stops being able to.
    expect(webState.contexts[0]?.state).toBe("closed");
  });

  test("a refused microphone hands the share back rather than leaving it running", async () => {
    installSharing();
    webState.denyMicrophone = true;
    const { recorder } = harness({ systemAudio: true });
    await expect(recorder.start()).rejects.toThrow(/microphone/i);
    expect(webState.displayTracks.every((track) => track.stopped)).toBe(true);
    expect(recorder.state).toBe("idle");
  });
});

/* -------------------------------------------------------------------------- */
/*                                 the meter                                  */
/* -------------------------------------------------------------------------- */

/**
 * `MediaRecorder` has no meter, so a browser published nothing and `Waveform`
 * drew its static silhouette for the length of every meeting — the flat bar
 * that reads as a dead microphone, which the owner has now lost an evening to
 * on two surfaces. An `AnalyserNode` over the same inputs being recorded is
 * what the shell has always done and what this now does.
 *
 * The distinction that matters in every case below is `capture/level.ts`'s:
 * **`null` is not zero.** `0` is "something is listening and the room is
 * quiet"; `null` is "nothing here can tell you". A browser with no
 * `AudioContext` is the second, and publishing a zero for it would put the
 * original defect back one layer down.
 */
