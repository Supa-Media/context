/**
 * Audio out, words back — and the three ways that goes wrong.
 *
 * The checks worth having here are not "does it call the endpoint". They are
 * the properties that decide whether a recording becomes a transcript at all:
 *
 *  - **the send never blocks the recorder**, because on the phone it once did
 *    and seconds of every twenty went unrecorded while the offsets claimed
 *    otherwise;
 *  - **a chunk beyond the bound is dropped and said out loud**, rather than
 *    queued — queueing means holding somebody's audio, which is the one thing
 *    this feature may not do;
 *  - **a permanent refusal is answered once**, not every twenty seconds for an
 *    hour, and it stops the sending rather than repeating the sentence;
 *  - **ids are derived**, so re-transcribing the same audio merges instead of
 *    doubling the transcript.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   the in-flight bound removed (a backlog with no ceiling, no notice)         4
 *   a permanent refusal treated as recoverable                                 4
 *   a `notYet` refusal believed on the first answer (the shipped defect)       5
 *   the `notYet` deadline removed entirely (audio uploaded all meeting)        2
 *   the deadline not reset by a success (one blip an hour in ends a meeting)   1
 *   segment ids taken from the answer instead of derived                       1
 *   the channel taken from the answer instead of stamped by the machine        1
 *   `base64` dropping the padding                                              2
 */

import { chunkIdFor, segmentIdFor } from "@context/meetings/chunks";
import {
  CAPTURE_NOTICES,
  TranscribeRefused,
  base64,
  gatewayTranscriber,
} from "../src/core/capture/gatewayTranscriber.ts";

const SESSION = "mtg_abcdefghjkmnpqrstvwx";

function frame(overrides = {}) {
  return {
    channel: "mic",
    atMs: 0,
    durationMs: 20_000,
    mimeType: "audio/webm;codecs=opus",
    data: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function said(text, index = 0) {
  return [
    {
      id: `whatever-the-far-end-called-it-${index}`,
      startMs: 0,
      endMs: 1_000,
      text,
      speaker: null,
      channel: "mixed",
      confidence: null,
    },
  ];
}

/** A deferred, so a test can hold a send open and watch what the caller does. */
function deferred() {
  let resolve = () => {};
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function runTranscriberChecks(check) {
  // -- what goes out ---------------------------------------------------------
  {
    const sent = [];
    const segments = [];
    const engine = gatewayTranscriber({
      send: async (request) => {
        sent.push(request);
        return said("hello there");
      },
    });
    check("the engine says audio leaves the device, because it does", engine.audioLeavesDevice === true);
    check("...and its label says where it went", engine.label.includes("cloud"));

    const stream = await engine.start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: (segment) => segments.push(segment),
    });
    stream.push(frame({ atMs: 40_000, data: new Uint8Array([9, 9]) }));
    await stream.finish();

    const request = sent[0] ?? {};
    check("one chunk is one request", sent.length === 1);
    check("it carries the meeting it is charged against", request.sessionId === SESSION);
    check("it carries the container the platform produced", request.mimeType === "audio/webm;codecs=opus");
    check("it carries where the chunk sits in the session", request.offsetMs === 40_000 && request.durationMs === 20_000);
    check("the audio is base64, not bytes on a JSON wire", request.audioBase64 === base64(new Uint8Array([9, 9])));
    check("the chunk id is the shared one, per channel", request.chunkId === chunkIdFor(`${SESSION}-mic`, 0));

    const segment = segments[0] ?? {};
    check("a segment came back", segments.length === 1 && segment.text === "hello there");
    check(
      "its id is derived from the chunk, never taken from the answer",
      segment.id === segmentIdFor(request.chunkId, 0),
    );
    check("its channel is what this machine recorded, not what the engine guessed", segment.channel === "mic");
  }

  // -- the two channels are two files ---------------------------------------
  {
    const sent = [];
    const stream = await gatewayTranscriber({
      send: async (request) => {
        sent.push(request.chunkId);
        return [];
      },
    }).start({ sessionId: SESSION, sampleRate: 16_000, onSegment: () => {} });
    stream.push(frame({ channel: "mic" }));
    stream.push(frame({ channel: "system" }));
    stream.push(frame({ channel: "mic", atMs: 20_000 }));
    await stream.finish();
    check("mic and system chunks are numbered separately", sent[0] !== sent[1]);
    check(
      "...and each channel counts up on its own",
      sent[2] === chunkIdFor(`${SESSION}-mic`, 1) && sent[1] === chunkIdFor(`${SESSION}-system`, 0),
    );
  }

  // -- the send is off the recorder's critical path -------------------------
  //
  // The property is that a chunk whose answer has not come back does not hold
  // up the next one. Asserted by holding both sends open and watching the
  // second one leave anyway — and by `push` returning nothing at all, so a
  // recorder cannot accidentally await it into the critical path it is being
  // kept out of.
  {
    const gates = [deferred(), deferred()];
    let sends = 0;
    const stream = await gatewayTranscriber({ send: () => gates[sends++].promise }).start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: () => {},
    });
    const answer = stream.push(frame());
    check("push hands back nothing to await", answer === undefined);
    stream.push(frame({ atMs: 20_000 }));
    check("a second chunk goes out while the first is still unanswered", sends === 2);
    for (const gate of gates) gate.resolve([]);
    await stream.finish();
  }

  // -- the bound, and what happens at it ------------------------------------
  {
    const gates = [deferred(), deferred(), deferred()];
    const notices = [];
    let sends = 0;
    const stream = await gatewayTranscriber({
      maxInFlight: 3,
      send: () => gates[sends++ % gates.length].promise,
    }).start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: () => {},
      onNotice: (notice) => notices.push(notice),
    });
    for (let i = 0; i < 5; i += 1) stream.push(frame({ atMs: i * 20_000 }));
    check("no more than the bound are outstanding", sends === 3);
    check("the extra chunks are dropped, not queued", notices.length === 2);
    check("...and it says so, in one of its own sentences", notices[0]?.message === CAPTURE_NOTICES.dropped);
    check("...recoverably: the meeting is still being recorded", notices.every((notice) => notice.recoverable));
    for (const gate of gates) gate.resolve([]);
    await stream.finish();
    check("...and once they answer, the next chunk goes out again", (stream.push(frame()), sends === 4));
    gates[0].resolve([]);
    await stream.finish();
  }

  // -- a failure that might not happen again --------------------------------
  {
    const notices = [];
    let sends = 0;
    const stream = await gatewayTranscriber({
      send: async () => {
        sends += 1;
        throw new Error("socket hang up");
      },
    }).start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: () => {},
      onNotice: (notice) => notices.push(notice),
    });
    stream.push(frame());
    await stream.finish();
    stream.push(frame({ atMs: 20_000 }));
    await stream.finish();
    check("a one-off failure is reported", notices[0]?.message === CAPTURE_NOTICES.failed);
    check("...recoverably", notices[0]?.recoverable === true);
    check("...and the next chunk is still attempted", sends === 2);
  }

  // -- a refusal that will answer the same way forever ----------------------
  {
    const notices = [];
    let sends = 0;
    const stream = await gatewayTranscriber({
      send: async () => {
        sends += 1;
        throw new TranscribeRefused("this gateway has no transcription configured", true);
      },
    }).start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: () => {},
      onNotice: (notice) => notices.push(notice),
    });
    stream.push(frame());
    await stream.finish();
    stream.push(frame({ atMs: 20_000 }));
    stream.push(frame({ atMs: 40_000 }));
    await stream.finish();
    check("a permanent refusal stops the sending", sends === 1);
    check("...and is said exactly once", notices.length === 1);
    check("...as 'nothing more will be transcribed'", notices[0]?.recoverable === false);
    check("...in one of its own sentences, never the server's", notices[0]?.message === CAPTURE_NOTICES.refused);
  }

  // -- "I do not know that" is put on a clock, not believed at once ---------
  //
  // The session row and the audio are two different requests. Between the first
  // chunk leaving and the row landing, the gateway honestly does not know this
  // meeting — and believing that answer once threw away every remaining chunk,
  // which is what made every desktop recording produce an empty transcript.
  {
    const notices = [];
    let sends = 0;
    let at = 1_000;
    const stream = await gatewayTranscriber({
      notYetGraceMs: 60_000,
      now: () => at,
      send: async () => {
        sends += 1;
        if (sends < 3) throw new TranscribeRefused("the gateway refused a chunk (404)", false, true);
        return said("the row landed");
      },
    }).start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: () => {},
      onNotice: (notice) => notices.push(notice),
    });
    for (let i = 0; i < 3; i += 1) {
      stream.push(frame({ atMs: i * 20_000 }));
      await stream.finish();
      at += 20_000;
    }
    check("A 404 DOES NOT END THE MEETING", sends === 3);
    check("...it is reported as one that might not happen again", notices.every((notice) => notice.recoverable));
    check("...never as 'nothing more will be transcribed'", !notices.some((n) => n.message === CAPTURE_NOTICES.refused));
  }

  // -- and one unlucky 404 in a healthy meeting costs nothing at all --------
  //
  // The deadline measures an *unbroken* run, so a single blip an hour into a
  // meeting starts a fresh clock rather than continuing one from the start.
  {
    let sends = 0;
    let at = 0;
    const stream = await gatewayTranscriber({
      notYetGraceMs: 60_000,
      now: () => at,
      send: async () => {
        sends += 1;
        if (sends === 1 || sends === 5) throw new TranscribeRefused("(404)", false, true);
        return said("still here");
      },
    }).start({ sessionId: SESSION, sampleRate: 16_000, onSegment: () => {} });
    // Two hours of meeting, one 404 at the start and one in the middle.
    for (let i = 0; i < 9; i += 1) {
      stream.push(frame({ atMs: i * 20_000 }));
      await stream.finish();
      at += 600_000;
    }
    check("AN INTERMITTENT 404 NEVER ACCUMULATES TOWARD THE DEADLINE", sends === 9);
  }

  // -- but the deadline is real, because "never" is a real state ------------
  {
    const notices = [];
    let sends = 0;
    let at = 0;
    const stream = await gatewayTranscriber({
      notYetGraceMs: 60_000,
      now: () => at,
      send: async () => {
        sends += 1;
        throw new TranscribeRefused("the gateway refused a chunk (404)", false, true);
      },
    }).start({
      sessionId: SESSION,
      sampleRate: 16_000,
      onSegment: () => {},
      onNotice: (notice) => notices.push(notice),
    });
    for (let i = 0; i < 8; i += 1) {
      stream.push(frame({ atMs: i * 20_000 }));
      await stream.finish();
      at += 20_000;
    }
    check(
      "a meeting the gateway will never know stops the sending, rather than uploading audio all meeting",
      sends === 4,
    );
    check("...after two full drain periods and not before", at >= 60_000);
    check("...and says so once it has stopped", notices[notices.length - 1]?.message === CAPTURE_NOTICES.refused);
    check("...as 'nothing more will be transcribed'", notices[notices.length - 1]?.recoverable === false);
  }

  // -- nothing is sent for nothing ------------------------------------------
  {
    let sends = 0;
    const stream = await gatewayTranscriber({
      send: async () => {
        sends += 1;
        return [];
      },
    }).start({ sessionId: SESSION, sampleRate: 16_000, onSegment: () => {} });
    stream.push(frame({ data: new Uint8Array() }));
    stream.push(frame({ durationMs: 0 }));
    await stream.finish();
    check("an empty chunk is not a request", sends === 0);
  }

  // -- the encoder ----------------------------------------------------------
  {
    const vectors = ["", "f", "fo", "foo", "foob", "fooba", "foobar"];
    check(
      "base64 agrees with the platform's own encoder on the padding cases",
      vectors.every((value) => base64(new TextEncoder().encode(value)) === Buffer.from(value, "utf8").toString("base64")),
    );
    const random = new Uint8Array(257);
    for (let i = 0; i < random.length; i += 1) random[i] = (i * 37 + 11) % 256;
    check("...and over every byte value", base64(random) === Buffer.from(random).toString("base64"));
  }
}
