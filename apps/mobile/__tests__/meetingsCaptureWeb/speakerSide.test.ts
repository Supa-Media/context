/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { SEGMENT_MS } from "../../features/meetings/capture/segments";
import { talkTimeline } from "../../features/meetings/capture/talkTimeline";
import type { TranscriptSegment } from "../../features/meetings/protocol";
import {
  advance,
  harness,
  installAudioContext,
  installSharing,
  resetWebBrowser,
  teardownWebBrowser,
  webState,
} from "./fixtures";

/**
 * WHO SAID A LINE: THE MICROPHONE OR THE CALL (board m5, owner 2026-10-17).
 *
 * The same two readings the live card's You and Call meters draw decide each
 * segment's side, and only when the meeting has a call to compare against. A
 * room meeting must never gain one: naming the microphone in a room is a false
 * attribution in somebody's permanent note.
 *
 * ## Sabotage record
 *
 *  - `channelFor` answering `mic` with no call reading: "a room meeting keeps
 *    what the engine said" and "a meeting with no call reading has no answer"
 *    fail.
 *  - The margin removed (`>= 0`): "two sides at nearly the same level name
 *    nobody" fails.
 */

beforeEach(() => {
  resetWebBrowser();
});

afterEach(() => {
  teardownWebBrowser();
});

/** Ten readings a second from `fromMs` to `toMs`. */
function speak(
  timeline: ReturnType<typeof talkTimeline>,
  fromMs: number,
  toMs: number,
  you: number | null,
  call: number | null,
): void {
  for (let at = fromMs; at <= toMs; at += 100) timeline.note(at, you, call);
}

describe("the talk timeline", () => {
  test("the louder side owns the line", () => {
    const talk = talkTimeline();
    speak(talk, 0, 3_000, 0.6, 0.05);
    speak(talk, 3_100, 6_000, 0.05, 0.6);
    expect(talk.channelFor(0, 3_000)).toBe("mic");
    expect(talk.channelFor(3_100, 6_000)).toBe("system");
  });

  test("the call bleeding into the microphone is still the call", () => {
    // Speakers, not headphones: the microphone hears the call, quieter.
    const talk = talkTimeline();
    speak(talk, 0, 3_000, 0.4, 0.6);
    expect(talk.channelFor(0, 3_000)).toBe("system");
  });

  test("two sides at nearly the same level name nobody", () => {
    const talk = talkTimeline();
    speak(talk, 0, 3_000, 0.5, 0.45);
    expect(talk.channelFor(0, 3_000)).toBe("mixed");
  });

  test("both talking at once names nobody", () => {
    const talk = talkTimeline();
    speak(talk, 0, 1_500, 0.6, 0.05);
    speak(talk, 1_600, 3_000, 0.05, 0.6);
    expect(talk.channelFor(0, 3_000)).toBe("mixed");
  });

  test("too little sound to go on names nobody", () => {
    const talk = talkTimeline();
    speak(talk, 0, 3_000, 0.1, 0.05);
    expect(talk.channelFor(0, 3_000)).toBe("mixed");
  });

  test("a meeting with no call reading has no answer", () => {
    const talk = talkTimeline();
    speak(talk, 0, 3_000, 0.6, null);
    expect(talk.channelFor(0, 3_000)).toBeNull();
  });

  test("old readings are let go, and a new session forgets them all", () => {
    const talk = talkTimeline();
    speak(talk, 0, 3_000, 0.6, 0.05);
    talk.note(10 * 60_000, 0.05, 0.05);
    expect(talk.channelFor(0, 3_000)).toBeNull();
    talk.clear();
    expect(talk.channelFor(10 * 60_000, 10 * 60_000)).toBeNull();
  });
});

function line(id: string, startMs: number, endMs: number): TranscriptSegment {
  return { id, startMs, endMs, text: id, speaker: null, channel: "mixed", confidence: null };
}

describe("the browser recorder", () => {
  test("a call's segments come back with the side that was louder", async () => {
    installSharing();
    const { recorder, transcriber } = harness({ systemAudio: true });
    const seen: string[] = [];
    recorder.onSegment((segment) => seen.push(`${segment.id}:${segment.channel}`));
    transcriber.answerWith([line("mine", 1_000, 8_000), line("theirs", 11_000, 18_000)]);

    webState.analyserAmplitude = 0.5;
    webState.callAmplitude = 0.001;
    await recorder.start();
    await advance(10_000);
    webState.analyserAmplitude = 0.001;
    webState.callAmplitude = 0.5;
    await advance(SEGMENT_MS - 10_000);

    expect(seen).toEqual(["mine:mic", "theirs:system"]);
    await recorder.stop();
  });

  test("a room meeting keeps what the engine said", async () => {
    installAudioContext();
    webState.analyserAmplitude = 0.5;
    const { recorder, transcriber } = harness({ systemAudio: false });
    const seen: string[] = [];
    recorder.onSegment((segment) => seen.push(segment.channel));
    transcriber.answerWith([line("room", 1_000, 8_000)]);
    await recorder.start();
    await advance(SEGMENT_MS);
    expect(seen).toEqual(["mixed"]);
    await recorder.stop();
  });
});
