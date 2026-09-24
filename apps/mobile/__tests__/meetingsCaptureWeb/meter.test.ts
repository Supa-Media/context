/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { onRecorderLevel } from "../../features/meetings/capture/level";
import {
  advance,
  harness,
  installAudioContext,
  installSharing,
  recordedStream,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * The level meter: no reading with no `AudioContext`, a moving mark with a
 * voice, zero as a real reading rather than "no meter", and why a meter must
 * never change what a mic-only meeting actually records. See `fixtures.ts`
 * for the fake browser this suite installs and the sabotage record that
 * proves it.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

describe("the meter", () => {
  function watchLevels(): number[] {
    const seen: number[] = [];
    // Never detached: the suite's own subscription for the length of one test,
    // and `onRecorderLevel`'s set is module state a fresh `harness()` does not
    // touch. Left attached it would collect another test's readings, so every
    // caller below reads it and the array dies with the test.
    onRecorderLevel((level) => seen.push(level ?? -1));
    return seen;
  }

  test("a browser with no AudioContext publishes nothing at all", async () => {
    const { recorder } = harness();
    const levels = watchLevels();
    await recorder.start();
    await advance(500);
    /*
      Not "publishes zero". A flat mark drawn from a real zero says the room is
      quiet, which this browser cannot know — so it never publishes a number at
      all and `Waveform` draws the silhouette it draws when there is no meter.
      The `null`s are the polling being started and stopped and are the same
      answer as saying nothing.
    */
    expect(levels.every((level) => level === -1)).toBe(true);
    await recorder.stop();
  });

  test("a room with a voice in it moves the mark", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0.5;
    const { recorder } = harness();
    const levels = watchLevels();
    await recorder.start();
    await advance(300);

    // The first entry is the `null` that starting the polling publishes; the
    // readings are what comes after it.
    const readings = levels.filter((level) => level >= 0);
    expect(readings.length).toBeGreaterThanOrEqual(3);
    // -6 dBFS on a meter floored at -55 is most of the way up it.
    expect(readings[0]).toBeGreaterThan(0.8);
    await recorder.stop();
  });

  /**
   * Digital silence is zero, and zero is a **reading**.
   *
   * `20 * log10(0)` is `-Infinity`, which `meterLevel` reads as "no reading" —
   * the one answer it must not be here, because something genuinely is
   * listening. Published as `null` this would draw the static silhouette over
   * an open microphone, which is the exact bug the meter exists to close.
   */
  test("a quiet room reads zero, which is not the same as no meter", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0;
    const { recorder } = harness();
    const levels = watchLevels();
    await recorder.start();
    await advance(300);

    const readings = levels.filter((level) => level >= 0);
    expect(readings.length).toBeGreaterThanOrEqual(3);
    expect(readings.every((level) => level === 0)).toBe(true);
    await recorder.stop();
  });

  /**
   * A METER IS A DECORATION AND MAY NOT CHANGE WHAT LANDS IN A BUCKET.
   *
   * The analyser is a sink hanging off the side of the microphone's own stream,
   * not a stage the recording passes through. Routing a mic-only meeting into
   * the mixing destination "for consistency" would put every browser recording
   * that ever worked through a `MediaStreamAudioDestinationNode` — resampled,
   * and silent outright on a context autoplay policy left suspended — to draw
   * five bars.
   */
  test("a microphone-only meeting records the microphone's own stream", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0.5;
    const { recorder } = harness();
    const levels = watchLevels();
    await recorder.start();
    await advance(300);

    expect(recordedStream()).toBe("microphone");
    expect(webState.contexts[0]?.destination).toBeNull();
    // ...and the meter still works, which is the point of doing it this way.
    expect(levels.filter((level) => level > 0).length).toBeGreaterThanOrEqual(3);
    await recorder.stop();
  });

  test("a meeting that ends says it has no reading rather than keeping its last", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0.5;
    const { recorder } = harness();
    const levels = watchLevels();
    await recorder.start();
    await advance(300);
    await recorder.stop();

    // `-1` is this suite's spelling of `null`: a mark holding a loud room over
    // a meeting that has ended is the same lie as one that never moves.
    expect(levels[levels.length - 1]).toBe(-1);
  });

  test("a paused meeting is not listening, and the meter says so", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0.5;
    const { recorder } = harness();
    const levels = watchLevels();
    await recorder.start();
    await advance(300);
    await recorder.pause();
    const atPause = levels.length;
    await advance(500);

    expect(levels[atPause - 1]).toBe(-1);
    // ...and nothing is published while paused, so the mark stays where it is.
    expect(levels).toHaveLength(atPause);
    await recorder.stop();
  });

  test("the shared source is in the reading, not just the microphone", async () => {
    installSharing();
    webState.analyserAmplitude = 0.5;
    const { recorder } = harness({ systemAudio: true });
    await recorder.start();

    // One analyser fed by every input: the question the mark answers is about
    // the recording, and the recording is both of them.
    const analyser = webState.contexts[0]?.analyser;
    expect(analyser).toBeDefined();
    expect(webState.contexts[0]?.sourced).toHaveLength(2);
    await recorder.stop();
  });
});
