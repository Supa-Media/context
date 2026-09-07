/**
 * THE SESSION ROW REACHES THE GATEWAY BEFORE THE FIRST CHUNK OF AUDIO.
 *
 * Every desktop recording was transcription-dead from its first chunk, on every
 * machine, deterministically — and nothing in this suite could see it, which is
 * the finding rather than the bug. The pieces were each covered and each
 * correct: `captureWindow.test.mjs` fakes `window.capture`, `controller.test.mjs`
 * drives `fakeRecorder`, `transcriber.test.mjs` drives a fake `send`,
 * `outbox.test.mjs` drives the reducer. **Nothing exercised the two of them
 * against one clock**, and the defect lived in exactly that gap:
 *
 *   packages/meetings/src/chunks.js   SEGMENT_MS        = 20_000
 *   core/sync/drain.ts                DRAIN_INTERVAL_MS = 30_000
 *
 * A session write that waits for the timer is later than the first chunk it
 * exists to make legal, because 20 < 30, always. The gateway answers a chunk for
 * a meeting it has never heard of with `404 meeting_forbidden` — `sessionGone()`
 * in `apps/mcp/src/meetings/transcribe.js` — the recorder read that as permanent,
 * set `givenUp`, and **silently dropped every remaining chunk of the meeting**,
 * including all the ones that would have succeeded once the row landed.
 *
 * So this file composes the real objects the way `main/index.ts` composes them —
 * the real `MeetingController`, the real outbox and `drainOnce`, the real
 * `gatewayTranscriber` and the real `transcribeChunk` — against one fake gateway
 * that records the order of what arrives and, like the real one, refuses a chunk
 * for a session it has not been told about. That last part is what makes the
 * ordering assertion mean something: the order is not a style preference, it is
 * the difference between a transcript and silence.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are for **this file only**;
 * most of these redden checks elsewhere too, and `transcriber.test.mjs`,
 * `transcribeRequest.test.mjs`, `controller.test.mjs` and
 * `consoleBridge.test.mjs` carry their own rows.
 *
 *   the race
 *     `requestDrain` never called from `begin()` (the shipped defect)          6
 *     `drainUrgency("session")` returning "timer"                             7
 *     the drain hung off `#queue` (one request per keystroke of the title)     1
 *     the console path no longer draining a session write                      1
 *     the shell no longer handing the controller a drain                       1
 *
 *   the 404
 *     any 404 read as permanent again (the shipped defect)                     6
 *     the `notYet` deadline believed on the first answer                       6
 *     the deadline removed entirely (audio uploaded all meeting)               4
 *
 *   the payloads
 *     the notice zeroed in `captureStateUpdate`                                1
 *     `frames` zeroed in `stopFromConsole`                                     1
 *     `captureStateUpdate` renamed, so the text guard cannot find it           1
 *
 * They fail on different checks on purpose: the first group is the race, the
 * second is a meeting surviving one, the third is anybody being able to see
 * either — which is what says these are separate properties rather than one
 * written eleven times.
 *
 * Two of those rows are worth reading twice. **The drain hung off `#queue`** is
 * the regression the obvious placement of the first fix would have introduced,
 * found in review rather than in a test. And the notice row read **0** until
 * the text guard was scoped to the function: a bare search for
 * `notice: view.notice` over the whole file is satisfied by the renderer
 * panel's `UiState`, which sets the same field a few hundred lines up.
 */

import { SEGMENT_MS } from "@context/meetings/chunks";
import { ERRORS, ROUTES } from "@context/meetings/protocol";
import { MeetingController } from "../src/core/recording/controller.ts";
import { fakePermissionBroker } from "../src/core/capture/permissions.ts";
import { fakeRecorder } from "../src/core/capture/recorder.ts";
import {
  CAPTURE_NOTICES,
  NOT_YET_GRACE_MS,
  gatewayTranscriber,
} from "../src/core/capture/gatewayTranscriber.ts";
import { transcribeChunk } from "../src/main/transcribe.ts";
import { emptyOutbox, queueWrite, reconcileDrain } from "../src/core/sync/outbox.ts";
import { DRAIN_INTERVAL_MS, drainOnce, drainUrgency } from "../src/core/sync/drain.ts";
import { fakeClock } from "./fakes.mjs";
import { readFileSync } from "node:fs";

const BASE_URL = "https://gateway.example.test";
const TOKEN = "fake-grant-token-not-a-real-one";
/** What `connectMachine` records; `postEntry` refuses a meeting without it. */
const SCOPE = "context:write context:private";
const SESSION = "mtg_abcdefghjkmnpqrstvwx";

/**
 * A gateway that knows what it has been told, and nothing else.
 *
 * The one behaviour that matters is `sessionGone()`'s: a chunk for a session
 * this gateway has never received answers `404 meeting_forbidden`, which is the
 * same answer it gives for another workspace's meeting and for one that never
 * existed. It cannot tell them apart, and neither can the client from one reply.
 */
function fakeGateway({ acceptSessions = true } = {}) {
  const calls = [];
  const known = new Set();

  async function impl(url, init) {
    const path = String(url).slice(BASE_URL.length);
    calls.push(path);

    if (path === ROUTES.sessions) {
      if (!acceptSessions) {
        return json(503, { error: ERRORS.unavailable, message: "not right now" });
      }
      known.add(JSON.parse(init.body).id);
      return json(200, {});
    }

    if (path === ROUTES.transcribe(SESSION)) {
      if (!known.has(SESSION)) {
        return json(404, { error: ERRORS.forbidden, message: "no such meeting session in this context" });
      }
      return json(200, {
        segments: [
          { id: "whatever-the-far-end-called-it", startMs: 0, endMs: 900, text: "words", speaker: null, channel: "mixed", confidence: null },
        ],
      });
    }

    return json(200, {});
  }

  impl.calls = calls;
  impl.tell = () => known.add(SESSION);
  return impl;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The shell, wired as `main/index.ts` wires it.
 *
 * Everything here is the real module: the controller, the queue, the drain, the
 * transcriber and the request that carries audio. What is faked is the two
 * things a suite cannot have — a microphone (`fakeRecorder`) and a network.
 */
function shell(impl, { drainOnStart = true } = {}) {
  const clock = fakeClock();
  const recorder = fakeRecorder();
  const notices = [];
  const segments = [];
  let outbox = emptyOutbox();
  let draining = Promise.resolve();

  const config = {
    baseUrl: BASE_URL,
    token: async () => TOKEN,
    scope: () => SCOPE,
    fetch: impl,
  };

  async function drainNow() {
    const before = outbox;
    const report = await drainOnce(before, config, () => clock.ms());
    outbox = reconcileDrain(before, report.outbox, outbox);
  }

  function drain() {
    draining = draining.then(drainNow, drainNow);
    return draining;
  }

  const controller = new MeetingController({
    recorder,
    transcriber: gatewayTranscriber({
      // The same clock the queue and the controller read, so "two drain periods"
      // is a real duration in this harness rather than a number of calls.
      now: () => clock.ms(),
      send: (request) =>
        transcribeChunk({ token: async () => TOKEN, baseUrl: () => BASE_URL }, request, impl),
    }),
    permissions: fakePermissionBroker(),
    device: { platform: "macos", name: "a laptop", appVersion: "0.1.0" },
    outbox: () => outbox,
    setOutbox: (next) => {
      outbox = next;
    },
    // The line under test. `drainOnStart: false` is `main` — a session write
    // that waits for the thirty-second timer.
    requestDrain: drainOnStart ? () => void drain() : undefined,
    now: clock.now,
    onChange: (view) => {
      if (view.notice !== null && notices[notices.length - 1] !== view.notice) notices.push(view.notice);
    },
    onSegment: (segment) => segments.push(segment),
    newId: () => SESSION,
  });

  return {
    controller,
    recorder,
    notices,
    segments,
    clock,
    drain,
    outbox: () => outbox,
    /** So a check can begin a meeting behind a queue that is already deep. */
    setOutbox: (next) => {
      outbox = next;
    },
    /** Let every request this shell has started come back. */
    settle: async () => {
      await draining;
      await new Promise((resolve) => setImmediate(resolve));
      await draining;
    },
  };
}

async function record(app) {
  return app.controller.begin({
    source: { kind: "zoom", app: "zoom.us" },
    title: "Design review",
    grantedEpisode: "manual:1",
    channels: ["mic"],
  });
}

/**
 * One rotation of the recorder, the round trip it starts, and the wall clock
 * moving by the length of the chunk that was just cut. A test that stepped the
 * recorder without moving time would spend a deadline measured in seconds
 * without any seconds passing.
 */
async function rotate(app) {
  app.recorder.step(SEGMENT_MS);
  await app.settle();
  app.clock.advance(SEGMENT_MS);
}

/**
 * One named function's source, from `function <name>` to the next line that is
 * a closing brace in column two.
 *
 * Crude on purpose, and it is the whole of what makes the text checks below
 * mean anything: these files are read as bytes because the suite cannot load
 * them, and a search over a whole file finds whatever else happens to spell the
 * same thing — the first version of this searched the file and passed with the
 * function it was guarding zeroed out.
 *
 * A name it cannot find answers the empty string rather than throwing, so a
 * renamed function reddens the two checks that read it and **nothing else**. A
 * throw here would kill every check after it in the whole suite, which is the
 * failure `endQuietly` exists for in `controller.test.mjs`: a guard that takes
 * the file down tells you less than one that goes red.
 */
function bodyOf(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) return "";
  const end = source.indexOf("\n  }", start);
  return end === -1 ? "" : source.slice(start, end);
}

export async function runSessionOrderChecks(check) {
  // -- the order, and the transcript that depends on it ----------------------
  {
    const impl = fakeGateway();
    const app = shell(impl);

    const startedAt = app.clock.ms();
    const begun = await record(app);
    check("the meeting started", begun.ok === true);
    await app.settle();

    const beforeAudio = [...impl.calls];
    check(
      "THE SESSION ROW GOES OUT WHEN THE MEETING STARTS, not when the timer next fires",
      beforeAudio.length === 1 && beforeAudio[0] === ROUTES.sessions,
    );
    check(
      "...and it did so without a single millisecond of the drain interval passing",
      app.clock.ms() - startedAt === 0 && DRAIN_INTERVAL_MS > 0,
    );
    check("...and the queue is empty, so it was sent rather than merely queued", app.outbox().entries.length === 0);

    await rotate(app);
    const transcribeAt = impl.calls.indexOf(ROUTES.transcribe(SESSION));
    const sessionAt = impl.calls.indexOf(ROUTES.sessions);
    check("the first chunk of audio was sent", transcribeAt !== -1);
    check(
      "THE SESSION ROW REACHED THE GATEWAY BEFORE THE FIRST CHUNK OF AUDIO",
      sessionAt !== -1 && sessionAt < transcribeAt,
    );
    check(
      "...so the chunk was transcribed rather than refused for a meeting nobody had mentioned",
      app.segments.length === 1 && app.segments[0]?.text === "words",
    );

    await rotate(app);
    check("...and the meeting goes on being transcribed", app.segments.length === 2);
    check("nothing had to be said about it", app.notices.length === 0);

    /*
      And the drain is hung off the *start* of a meeting, not off the queue.

      `#queue("session", …)` also runs from `title()`, which the notepad calls on
      every keystroke of the title field. A drain attached to the queue call
      rather than to `begin()` would be one HTTP request per keystroke — the
      failure `SYNC_THROTTLE_MS` and `reconcileDrain` both exist to avoid,
      introduced while fixing a different one. Found reviewing this change, which
      is why it is a check and not a comment.
    */
    const before = impl.calls.length;
    for (const typed of ["D", "De", "Des", "Desi", "Desig"]) app.controller.title(typed);
    await app.settle();
    check(
      "TYPING A TITLE IS NOT A REQUEST PER KEYSTROKE",
      impl.calls.length === before,
    );
  }

  // -- and the same shell with the fix removed, which is what shipped --------
  //
  // Not a second implementation of the check above: it is the same harness with
  // `requestDrain` withheld, which is `main`. It is here so the failure this
  // file exists for is a *recorded observation* rather than a claim in a
  // comment, and so that "20 < 30" is demonstrated rather than asserted.
  {
    const impl = fakeGateway();
    const app = shell(impl, { drainOnStart: false });
    await record(app);
    await app.settle();
    check(
      "a session write left to the timer has not reached the gateway when the meeting starts",
      impl.calls.length === 0,
    );
    await rotate(app);
    check(
      "...so the first chunk of audio arrives at a gateway that has never heard of the meeting",
      impl.calls[0] === ROUTES.transcribe(SESSION) && app.segments.length === 0,
    );
  }

  // -- THE REAL TRACE, REPLAYED --------------------------------------------
  //
  // The centre of this change. A gateway that answers 404 for a session it has
  // not received and 200 once the session write lands — which is exactly what
  // the owner's own 27-second recording hit — and the property that must hold
  // is that **every chunk of audio is attempted, and none is silently
  // skipped.** A chunk refused by a 404 loses its words, and that is by design
  // (audio is never queued, so there is nothing to retry); what must never
  // happen is `givenUp` swallowing the chunks *after* it, which is what turned
  // one unlucky reply into a whole meeting of silence.
  //
  // Driven with the early drain withheld, so the row lands on the timer and the
  // race is real rather than arranged away.
  {
    const impl = fakeGateway();
    const app = shell(impl, { drainOnStart: false });
    await record(app);

    // Two chunks race the row, exactly as they did on the hardware.
    await rotate(app);
    await rotate(app);
    check(
      "both chunks that raced the session row were attempted",
      impl.calls.filter((path) => path === ROUTES.transcribe(SESSION)).length === 2,
    );
    check("...and neither produced words, because the gateway did not know the meeting", app.segments.length === 0);
    check("...and the meeting was told, recoverably", app.notices[0] === CAPTURE_NOTICES.failed);

    // The timer fires. This is t≈30s in the trace, where the row finally lands.
    await app.drain();

    // Six more chunks — two minutes of meeting, well past the deadline had the
    // clock kept running.
    for (let i = 0; i < 6; i += 1) await rotate(app);

    const attempts = impl.calls.filter((path) => path === ROUTES.transcribe(SESSION)).length;
    check("EVERY CHUNK OF AUDIO REACHED THE GATEWAY — none was skipped", attempts === 8);
    check(
      "...and every chunk after the session row landed came back as words",
      app.segments.length === 6,
    );
    check(
      "...so the meeting was never given up on",
      !app.notices.includes(CAPTURE_NOTICES.refused),
    );
  }

  // -- and the deadline is real, because "never" is a real state ------------
  //
  // A gateway that will never accept the session row: the 404s never stop. This
  // must end, or the app uploads a full chunk of audio every twenty seconds for
  // the length of a meeting to something refusing every one.
  {
    const impl = fakeGateway({ acceptSessions: false });
    const app = shell(impl, { drainOnStart: false });
    await record(app);
    const startedAt = app.clock.ms();

    /*
      Measured as a *duration*, and deliberately against `DRAIN_INTERVAL_MS`
      rather than against `NOT_YET_GRACE_MS`.

      A check that divides the grace by the chunk length agrees with any value
      the grace is given, including a wrong one — it restates the constant
      instead of asserting anything about it. What has to be true is that a
      meeting keeps trying for **two full drain periods**, because that is how
      long the thing it is waiting for can take, so that is the number here.
    */
    let gaveUpAfterMs = null;
    for (let i = 0; i < 10; i += 1) {
      const before = impl.calls.length;
      await rotate(app);
      if (impl.calls.length === before && gaveUpAfterMs === null) {
        gaveUpAfterMs = app.clock.ms() - startedAt - SEGMENT_MS;
      }
    }

    const attempts = impl.calls.filter((path) => path === ROUTES.transcribe(SESSION)).length;
    check(
      "a meeting the gateway will never know stops the sending rather than uploading all meeting",
      attempts < 10 && gaveUpAfterMs !== null,
    );
    check(
      "...AND NOT BEFORE TWO FULL DRAIN PERIODS OF TRYING",
      (gaveUpAfterMs ?? -1) >= 2 * DRAIN_INTERVAL_MS,
    );
    check(
      "...which is what the constant says, derived rather than typed out",
      NOT_YET_GRACE_MS === 2 * DRAIN_INTERVAL_MS,
    );
    check(
      "...and says so once, in the sentence that tells a person their notes still land",
      app.notices[app.notices.length - 1] === CAPTURE_NOTICES.refused,
    );
  }

  // -- the console's half of the same rule, read as text --------------------
  //
  // `main/index.ts` imports Electron at the top level and this suite cannot
  // load it, so the *other* writer — `writeMeetingFromConsole`, the path a
  // meeting the page started takes — is reachable only as bytes. Everything
  // above drives `MeetingController`, and withholding the console's own drain
  // reddens **nothing** in this file. That gap is why this is here.
  //
  // **It is for the accident, not the adversary**, in the same sense as
  // `consoleBridge.test.mjs`'s census, and it is a lower bound: it proves the
  // rule is consulted and that all three of its answers are acted on, not that
  // they are acted on correctly. What it catches is somebody deleting a branch,
  // which is the way this would actually regress.
  {
    const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
    check(
      "the console's write path asks `drainUrgency` rather than naming kinds itself",
      /drainUrgency\(write\.kind\)/.test(source),
    );
    check(
      "...and acts on all three answers, so a session is not quietly left to the timer",
      /=== "await"\) await drain\(\)/.test(source) && /=== "now"\) void drain\(\)/.test(source),
    );
    check(
      "...and the shell hands the controller a drain to call",
      /requestDrain: \(\) => void drain\(\)/.test(source),
    );
    check(
      "...and the timer is still the floor under both of them",
      /setInterval\(\(\) => void drain\(\), DRAIN_INTERVAL_MS\)/.test(source),
    );
    /*
      The same gap, for the two payload fields this change added. Both are
      filled in `main/index.ts` — `captureStateUpdate` and `stopFromConsole` —
      and both were the *point*: a notice nothing sends and a frame count
      nothing carries are the defect this whole change is about, one layer up.
      Zeroing either reddens nothing that can be loaded, so it is read here.

      **Scoped to the function, and the first version of this was not.** A bare
      search for `notice: view.notice` over the whole file is satisfied by the
      renderer panel's `UiState`, which sets the same field a few hundred lines
      up — so the guard passed with `captureStateUpdate` zeroed out, which is a
      lower bound wearing an equals sign. Measured: 0 red before the scoping.
    */
    check(
      "the shell puts its own notice on the capture state, rather than a null",
      /notice: view\.notice,/.test(bodyOf(source, "captureStateUpdate")),
    );
    check(
      "...and the finished summary carries the frames the recorder counted",
      /frames: finished\.frames,/.test(bodyOf(source, "stopFromConsole")),
    );
  }

  // -- the arithmetic, stated as a check ------------------------------------
  //
  // The whole defect is one comparison, so it is worth having one check that
  // holds the comparison rather than its consequences. This is the check that
  // reddens if somebody lengthens a chunk, shortens the timer, or decides a
  // session write can wait like the other three.
  {
    check(
      "THE OUTBOX DRAINS SLOWER THAN CHUNKS ROTATE, so a session write must not wait for the timer",
      SEGMENT_MS >= DRAIN_INTERVAL_MS || drainUrgency("session") !== "timer",
    );
    check(
      "...which is the state this app is actually in: 20 s chunks, a 30 s timer",
      SEGMENT_MS < DRAIN_INTERVAL_MS,
    );
    check(
      "a finalize is still awaited, because its answer is where the note landed",
      drainUrgency("finalize") === "await",
    );
    check(
      "...and segments and notes still wait, because a meeting is sent in one pass",
      drainUrgency("segments") === "timer" && drainUrgency("notes") === "timer",
    );
  }

  // -- A MEETING BEGUN BEHIND A QUEUE THAT IS ALREADY DEEP -------------------
  //
  // The residual the fire-and-forget drain names out loud — *"on a long queue
  // the new session entry is at the back of `nextDrain`'s ordering and may not
  // make it into this pass"* — driven rather than reasoned about. Added in
  // review, because the sentence after it, *"which is the case the second fix
  // exists for"*, is true for **one** missed pass and stops being true after
  // two: a pass carries at most 25 entries and costs a whole
  // `DRAIN_INTERVAL_MS`, so a queue three passes deep holds the row past
  // `NOT_YET_GRACE_MS` and the meeting is given up exactly as it used to be.
  // Measured on this machine's numbers: a transcript through 74 queued entries,
  // none at 75. The table is in `docs/decisions/desktop.md`.
  //
  // This checks the side that must keep working — one missed pass — so it
  // reddens if the deadline is ever shortened below the timer it outlasts.
  {
    const impl = fakeGateway();
    const app = shell(impl);
    let queued = app.outbox();
    for (let i = 0; i < 30; i += 1) {
      queued = queueWrite(queued, {
        sessionId: `mtg_older${i}`,
        kind: "notes",
        body: { notes: "an earlier meeting, still going out" },
        now: app.clock.ms(),
      });
    }
    app.setOutbox(queued);
    // Strictly later than every entry above, so the ordering really does put
    // this meeting's row behind them rather than leaving it to `id`.
    app.clock.advance(5_000);
    await record(app);
    await app.settle();
    check(
      "a meeting begun behind a full pass does not get its session row out in that pass",
      !impl.calls.includes(ROUTES.sessions),
    );

    await rotate(app);
    await app.drain();
    await rotate(app);
    check(
      "...AND STILL GETS A TRANSCRIPT, because the deadline outlasts the pass it missed",
      app.segments.length >= 1,
    );
    check(
      "...rather than being given up on the chunk that raced it",
      !app.notices.includes(CAPTURE_NOTICES.refused),
    );
    check(
      "...which is the arithmetic that has to hold for that to be true",
      NOT_YET_GRACE_MS > DRAIN_INTERVAL_MS,
    );
  }
}
