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
 * Run as temporary local edits and reverted:
 *
 *   `requestDrain` never called from `begin()` (the shipped defect)             5
 *   `drainUrgency("session")` returning "timer" (the same defect, stated)       6
 *   404 + `meeting_forbidden` read as permanent again                           4
 *   `UNKNOWN_SESSION_GRACE` reduced to 1                                        3
 *   the unknown-session budget spent on the first answer                        4
 *   the drain hung off `#queue` instead of `begin()` (a request per keystroke)  1
 *
 * Counts for this file only; several of those redden checks elsewhere too, and
 * `transcriber.test.mjs` and `transcribeRequest.test.mjs` carry their own rows.
 * The rows fail on different checks on purpose — the first two are the race, the
 * next three are the meeting surviving one, and the last is the regression that
 * the obvious placement of the first fix would have introduced — which is what
 * says these are separate properties rather than one written six times.
 */

import { SEGMENT_MS } from "@context/meetings/chunks";
import { ERRORS, ROUTES } from "@context/meetings/protocol";
import { MeetingController } from "../src/core/recording/controller.ts";
import { fakePermissionBroker } from "../src/core/capture/permissions.ts";
import { fakeRecorder } from "../src/core/capture/recorder.ts";
import {
  CAPTURE_NOTICES,
  UNKNOWN_SESSION_GRACE,
  gatewayTranscriber,
} from "../src/core/capture/gatewayTranscriber.ts";
import { transcribeChunk } from "../src/main/transcribe.ts";
import { emptyOutbox, reconcileDrain } from "../src/core/sync/outbox.ts";
import { DRAIN_INTERVAL_MS, drainOnce, drainUrgency } from "../src/core/sync/drain.ts";
import { fakeClock } from "./fakes.mjs";

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

/** One rotation of the recorder, and the round trip it starts. */
async function rotate(app) {
  app.recorder.step(SEGMENT_MS);
  await app.settle();
}

export async function runSessionOrderChecks(check) {
  // -- the order, and the transcript that depends on it ----------------------
  {
    const impl = fakeGateway();
    const app = shell(impl);

    const begun = await record(app);
    check("the meeting started", begun.ok === true);
    await app.settle();

    const beforeAudio = [...impl.calls];
    check(
      "THE SESSION ROW GOES OUT WHEN THE MEETING STARTS, not when the timer next fires",
      beforeAudio.length === 1 && beforeAudio[0] === ROUTES.sessions,
    );

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

  // -- the second half, which holds on its own ------------------------------
  //
  // Even with the row sent early, a slow session write still loses a meeting if
  // one 404 is final. So: no early drain, the row lands on the timer, and the
  // meeting has to survive the chunks that raced it.
  {
    const impl = fakeGateway();
    const app = shell(impl, { drainOnStart: false });
    await record(app);
    await rotate(app);
    check(
      "a chunk refused for an unknown session does not end the meeting's transcript",
      app.segments.length === 0 && app.notices[0] === CAPTURE_NOTICES.failed,
    );

    // The timer fires and the row lands, exactly as it would at thirty seconds.
    await app.drain();
    await rotate(app);
    check(
      "...and once the session row lands, the very next chunk is transcribed",
      app.segments.length === 1,
    );
    check(
      "...which is a whole meeting that used to be thrown away on its first chunk",
      !app.notices.includes(CAPTURE_NOTICES.refused),
    );
  }

  // -- but "not yet" is not "never", and the difference is bounded ----------
  {
    const impl = fakeGateway({ acceptSessions: false });
    const app = shell(impl, { drainOnStart: false });
    await record(app);
    for (let i = 0; i < UNKNOWN_SESSION_GRACE + 3; i += 1) await rotate(app);

    const attempts = impl.calls.filter((path) => path === ROUTES.transcribe(SESSION)).length;
    check(
      "a session the gateway will never know stops the sending, rather than uploading audio all meeting",
      attempts === UNKNOWN_SESSION_GRACE,
    );
    check(
      "...and says so once, in the sentence that tells a person their notes still land",
      app.notices[app.notices.length - 1] === CAPTURE_NOTICES.refused,
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
}
