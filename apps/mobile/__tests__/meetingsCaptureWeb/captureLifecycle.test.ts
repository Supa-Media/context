/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { SEGMENT_MS } from "../../features/meetings/capture/segments";
import {
  advance,
  harness,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * What takes the microphone away mid-meeting, how a meeting ends, and why the
 * captured audio is structurally transient. See `fixtures.ts` for the fake
 * browser this suite installs and the sabotage record that proves it.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

describe("things taking the microphone away", () => {
  test("an interruption is survivable and the session keeps running", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    webState.tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(true);
    expect(recorder.state).toBe("recording");
    await recorder.stop();
  });

  test("capture comes back when the input does", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    webState.tracks[0].dispatchEvent(new Event("mute"));
    await advance(0);
    const before = webState.instances.length;

    webState.tracks[0].dispatchEvent(new Event("unmute"));
    await advance(0);
    expect(webState.instances.length).toBeGreaterThan(before);

    await advance(SEGMENT_MS);
    expect(transcriber.chunks.length).toBeGreaterThan(0);
    await recorder.stop();
  });

  /**
   * `ended` is the device unplugged or the permission revoked in site settings.
   * There is nothing to wait for, so it is not an interruption — the session
   * becomes a typed one and the stream is released rather than left held.
   */
  test("a microphone that goes away is not an interruption", async () => {
    const { recorder, errors } = harness();
    await recorder.start();

    webState.tracks[0].dispatchEvent(new Event("ended"));
    await advance(0);

    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
    expect(recorder.state).toBe("stopped");
    expect(webState.tracks[0].stopped).toBe(true);
  });
});

describe("ending", () => {
  /**
   * The browser keeps its recording indicator lit until every track is stopped.
   * A page that leaves it on is the web's version of iOS's red bar over an app
   * somebody thought they had finished with.
   */
  test("ending a meeting turns the browser's recording indicator off", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);
    await recorder.stop();
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });

  /** Same second lock as the phone's, for the same red-bar reason. */
  test("resuming a meeting that ended does not reopen the microphone", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    const opened = webState.instances.length;

    await recorder.resume();

    expect(webState.instances).toHaveLength(opened);
    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });

  test("stopping twice is safe", async () => {
    const { recorder } = harness();
    await recorder.start();
    await recorder.stop();
    await recorder.stop();
    expect(recorder.state).toBe("stopped");
  });
});

describe("the audio is transient, structurally", () => {
  /**
   * There is no file on disk to delete here: the chunk is a `Blob` in a local
   * that goes out of scope when the send returns. What has to be true is the
   * same thing the phone's test asserts — that the interface hands nobody a way
   * to ask for it.
   */
  test("the recorder exposes no way to read what it captured", async () => {
    const { recorder } = harness();
    await recorder.start();
    await advance(SEGMENT_MS);

    expect(Object.keys(recorder).sort()).toEqual([
      "capability",
      "onError",
      "onSegment",
      "pause",
      "resume",
      "start",
      "state",
      "stop",
    ]);
    await recorder.stop();
  });

  test("speaker is null on every segment that reaches a listener", async () => {
    const { recorder, transcriber } = harness();
    const seen: (string | null)[] = [];
    recorder.onSegment((segment) => seen.push(segment.speaker));
    transcriber.answerWith([
      {
        id: "seg-1",
        startMs: 0,
        endMs: 1_200,
        text: "Let's ship it.",
        speaker: "Somebody",
        channel: "mic",
        confidence: 0.8,
      },
    ]);
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(seen).toEqual([null]);
    await recorder.stop();
  });
});

/* -------------------------------------------------------------------------- */
/*                      what an adversarial review found                      */
/* -------------------------------------------------------------------------- */

describe("the stream is let go whatever the network did", () => {
  /**
   * The browser's recording dot is lit until every track is stopped, and
   * `releaseStream()` used to sit behind an awaited send inside the same arrow.
   * A last chunk that could not be transcribed — the ordinary way a meeting
   * ends on a bad link — meant the rejection escaped, `queue` turned it into a
   * report, and the dot stayed on for the life of the tab.
   */
  test("a last chunk that cannot be transcribed still stops the tracks", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(5_000);
    transcriber.refuse("the network went away");

    await recorder.stop();

    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });

  /** Same for the microphone going away mid-meeting. */
  test("a microphone that goes away releases the stream even if the send fails", async () => {
    const { recorder, transcriber } = harness();
    await recorder.start();
    await advance(5_000);
    transcriber.refuse("the network went away");

    webState.tracks[0].dispatchEvent(new Event("ended"));
    await advance(0);

    expect(recorder.state).toBe("stopped");
    expect(webState.tracks.every((track) => track.stopped)).toBe(true);
  });
});

