/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { CAPTURE_MESSAGES } from "../../features/meetings/capture/audio.web";
import { MAX_INFLIGHT_CHUNKS, SEGMENT_MS, chunkIdFor } from "../../features/meetings/capture/segments";
import {
  TEST_MEETING_ID,
  advance,
  harness,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * Everything about the send being off the device's critical path: rotation
 * under a hanging transcriber, the backlog cap, offline behaviour, a chunk
 * that will not close, the interruption flag, what the screen is allowed to
 * be told, and the stream as a guard rather than a hope. See `fixtures.ts` for
 * the fake browser this suite installs and the sabotage record that proves it.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

describe("the send is off the device's critical path", () => {
  test("rotation reopens the recorder without waiting for the answer", async () => {
    const { recorder, transcriber } = harness({ hang: true });
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(transcriber.chunks.map((chunk) => chunk.offsetMs)).toEqual([
      0,
      SEGMENT_MS,
      SEGMENT_MS * 2,
    ]);
    // One `MediaRecorder` per chunk plus the one currently open.
    expect(webState.instances).toHaveLength(4);
    expect(webState.instances.every((instance) => instance.started === 1)).toBe(true);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });

  /** Bounded, and what it drops it says. Same decision as the phone's. */
  test("a backlog is bounded, and what it drops it says", async () => {
    const { recorder, transcriber, errors } = harness({ hang: true });
    await recorder.start();

    await advance(SEGMENT_MS * 6);

    expect(transcriber.chunks).toHaveLength(MAX_INFLIGHT_CHUNKS);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((error) => CAPTURE_MESSAGES.includes(error.message))).toBe(true);
    expect(errors.some((error) => /dropped/i.test(error.message))).toBe(true);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });

  /**
   * Offline, a browser has nowhere to keep audio (the phone does — see
   * `spool.ts`), so it does not dispatch a chunk into an action that will not
   * answer, and it says what is true once rather than every twenty seconds:
   * this stretch is not being transcribed, the notes are fine, and the phone
   * keeps audio offline. Not "running behind", which blamed the transcriber.
   */
  test("offline, a browser says once that it is not keeping the audio, and sends nothing", async () => {
    const { recorder, transcriber, errors } = harness();
    await recorder.start();
    const had = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      await advance(SEGMENT_MS * 4);
      expect(transcriber.chunks).toHaveLength(0);
      const said = errors.map((error) => error.message);
      expect(said.filter((message) => /offline/i.test(message))).toHaveLength(1);
      expect(said.every((message) => CAPTURE_MESSAGES.includes(message))).toBe(true);
      expect(said.join(" ")).toMatch(/typed notes are still saved/);
      expect(said.join(" ")).not.toMatch(/running behind/);
      expect(recorder.state).toBe("recording");
    } finally {
      delete (navigator as { onLine?: boolean }).onLine;
      if (had !== undefined) Object.defineProperty(Object.getPrototypeOf(navigator), "onLine", had);
    }
    // Back online, the next chunk goes as it always did.
    await advance(SEGMENT_MS);
    expect(transcriber.chunks).toHaveLength(1);
    void recorder.stop();
    await advance(0);
  });

  /**
   * A chunk that will not close costs its own audio and nothing else — the
   * next twenty seconds are recorded rather than lost with it, and the wall
   * clock keeps the time that passed.
   */
  test("a chunk that will not close does not take the next twenty seconds too", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();

    webState.refuseStop = true;
    await advance(SEGMENT_MS);
    webState.refuseStop = false;
    // A fresh recorder was opened on the same tick that failed to close.
    expect(webState.instances).toHaveLength(2);

    await advance(SEGMENT_MS);

    expect(transcriber.chunks).toHaveLength(1);
    expect(transcriber.chunks[0].offsetMs).toBe(SEGMENT_MS);
    expect(transcriber.chunks[0].chunkId).toBe(chunkIdFor(TEST_MEETING_ID, 0));

    void recorder.stop();
    await advance(0);
  });
});

describe("the interruption flag is not sticky", () => {
  /**
   * `mute` set `interrupted` and only `unmute` cleared it. A pause and a resume
   * in between left the flag on, so the `mute` handler's guard returned for the
   * rest of the meeting and a second interruption was never reported.
   */
  test("an interruption survived a pause is reported again", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    webState.tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);
    expect(errors).toHaveLength(1);

    await recorder.pause();
    await recorder.resume();
    await advance(0);

    webState.tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);

    expect(errors).toHaveLength(2);
    expect(errors[1].recoverable).toBe(true);

    void recorder.stop();
    await advance(0);
  });
});

describe("nothing to transcribe to", () => {
  test("with nowhere to send, the stream is let go rather than held", async () => {
    const { recorder, errors } = harness({ noTranscriber: true });
    await recorder.start();

    await advance(SEGMENT_MS * 3);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(errors[0].message).toMatch(/not being transcribed/i);
    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("what the screen is allowed to be told", () => {
  test("an upstream error never reaches the screen in its own words", async () => {
    const { recorder, transcriber, errors } = harness();
    await recorder.start();
    transcriber.refuse(`Argument too large: {"audioBase64":"${"Q".repeat(200)}"}`);

    await advance(SEGMENT_MS);

    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(CAPTURE_MESSAGES).toContain(error.message);
      expect(error.message).not.toContain("QQQ");
    }

    void recorder.stop();
    await advance(0);
  });
});

describe("a screen's bug is not a reason to keep the stream", () => {
  /**
   * Same as the phone's: `report` reaches listeners from a rotation timer and
   * from a track event, both through a `void queue(...)`, so a listener that
   * threw rejected the device chain and took `stop()` with it.
   */
  test("a throwing error listener does not take the stream with it", async () => {
    const { recorder, transcriber } = harness();
    recorder.onError(() => {
      throw new Error("a screen with a bug in it");
    });
    await recorder.start();

    transcriber.refuse("the network went away");
    await advance(SEGMENT_MS * 2);

    expect(transcriber.chunks).toHaveLength(2);
    expect(recorder.state).toBe("recording");

    await expect(recorder.stop()).resolves.toBeUndefined();
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });
});

describe("the stream is a guard, not a hope", () => {
  /**
   * The `finally`s around `releaseStream` need a reachable trigger to be
   * guards, and assembling the chunk's `Blob` is it: a long recording on a tab
   * under memory pressure. Nothing else in `closeChunk` can throw any more, so
   * without these the browser's recording dot outlives the meeting silently.
   */
  test("ending releases the stream even if the chunk cannot be assembled", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(5_000);
    webState.blobConstructionFails = true;

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });

  test("a microphone that goes away releases it too", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(5_000);
    webState.blobConstructionFails = true;

    webState.tracks[0].dispatchEvent(new Event("ended"));
    await advance(0);

    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });

  test("and a rotation that cannot assemble one still reopens the recorder", async () => {
    const { recorder } = harness();
    await recorder.start();

    webState.blobConstructionFails = true;
    await advance(SEGMENT_MS);
    webState.blobConstructionFails = false;

    expect(webState.instances).toHaveLength(2);
    expect(recorder.state).toBe("recording");

    void recorder.stop();
    await advance(0);
  });
});

describe("giving capture up is not undone by the verbs", () => {
  /** Same hole as the phone's, for the same reason. See `audio.ts`. */
  test("a pause after capture was given up does not put the stream back in reach", async () => {
    const { recorder } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(recorder.state).toBe("stopped");

    await recorder.pause();
    expect(recorder.state).toBe("stopped");

    const opened = webState.instances.length;
    await recorder.resume();
    expect(recorder.state).toBe("stopped");
    expect(webState.instances).toHaveLength(opened);
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });

  /** The same hole reached the other way: the pause is what gives capture up. */
  test("a pause that is itself given up on stays given up", async () => {
    const { recorder } = harness({ noTranscriber: true });
    await recorder.start();
    await advance(5_000);

    await recorder.pause();

    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);

    const opened = webState.instances.length;
    await recorder.resume();
    expect(recorder.state).toBe("stopped");
    expect(webState.instances).toHaveLength(opened);
  });

  /** And a pause after the meeting ended does not reopen anything either. */
  test("a pause after the end stays ended", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    const opened = webState.instances.length;

    await recorder.pause();

    expect(recorder.state).toBe("stopped");
    await recorder.resume();
    expect(webState.instances).toHaveLength(opened);
  });
});
