/**
 * The one request in this app that carries audio.
 *
 * `main/transcribe.ts` imports no Electron — deliberately, so the request that
 * puts somebody's meeting on a network is checked here rather than by holding
 * one. Two things are being asserted, and the second is the one that decides
 * whether a person is told anything useful:
 *
 *  - **the credential is a header and appears nowhere else**, the same rule
 *    `sync/client.ts` holds, for the same reason: this URL is composed from a
 *    stored base URL and a contract route, and a token in it lands in every
 *    proxy log between here and the gateway;
 *  - **a refusal is classified**, because "this gateway has no transcription
 *    route" must stop the sending for the rest of the meeting while "the wifi
 *    dropped" must not.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted:
 *
 *   the token appended as `?token=` rather than a header                       2
 *   every refusal classified as permanent (one blip ends the transcript)       4
 *   any 404 classified as permanent (the shipped defect)                       4
 *   `notYet` widened to 501 as well (a dead deployment retried all meeting)    1
 *   `permanent` losing its 405/501 arm (a message every twenty seconds)        2
 *   the route spelled locally instead of taken from ROUTES                     1
 *   the network failure's own message relayed (it can quote the URL)           1
 */

import { ERRORS, ROUTES } from "@context/meetings/protocol";
import { TranscribeRefused } from "../src/core/capture/gatewayTranscriber.ts";
import { transcribeChunk } from "../src/main/transcribe.ts";
import { fakeFetch } from "./fakes.mjs";

const SESSION = "mtg_abcdefghjkmnpqrstvwx";
const TOKEN = "fake-grant-token-not-a-real-one";

/** Just enough `GatewayConnection` for a request. */
function connection(token = TOKEN, baseUrl = "https://gateway.example.test") {
  return { token: async () => token, baseUrl: () => baseUrl };
}

const request = {
  sessionId: SESSION,
  audioBase64: "AAAA",
  mimeType: "audio/webm;codecs=opus",
  chunkId: `${SESSION}-mic-0`,
  offsetMs: 20_000,
  durationMs: 20_000,
};

async function refusal(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

export async function runTranscribeRequestChecks(check) {
  // -- what goes out ---------------------------------------------------------
  {
    const segment = { id: "x", startMs: 20_000, endMs: 21_000, text: "hello", speaker: null, channel: "mixed", confidence: null };
    const impl = fakeFetch([{ status: 200, body: { segments: [segment] } }]);
    const { segments, refusedSegments } = await transcribeChunk(connection(), request, impl);
    const call = impl.calls[0] ?? { url: "", init: { headers: {}, body: "{}" } };
    check("the route is the contract's", call.url === `https://gateway.example.test${ROUTES.transcribe(SESSION)}`);
    check("THE CREDENTIAL IS NOT IN THE URL", !call.url.includes(TOKEN));
    check("the credential is in the Authorization header", call.init.headers.authorization === `Bearer ${TOKEN}`);
    const body = JSON.parse(call.init.body);
    check("the audio goes in the body", body.audioBase64 === "AAAA");
    check("...with the container the platform produced", body.mimeType === "audio/webm;codecs=opus");
    check("...and where the chunk sits in the meeting", body.offsetMs === 20_000 && body.durationMs === 20_000);
    check("...and its stable id", body.chunkId === `${SESSION}-mic-0`);
    check("the words come back", segments.length === 1 && segments[0]?.text === "hello");
    check(
      "a gateway that names no refusal count is read as having refused nothing",
      refusedSegments === 0,
    );
  }

  // -- an unconnected machine sends nothing ---------------------------------
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [] } }]);
    const error = await refusal(transcribeChunk(connection(null), request, impl));
    check("a machine with no token does not post audio at all", impl.calls.length === 0);
    check("...and says so as a refusal that will not change this meeting", error instanceof TranscribeRefused && error.permanent === true);
  }

  // -- refusals that will answer the same way forever ------------------------
  //
  // 501 is this gateway's own documented "no transcription configured here" and
  // 405 is a route that does not take a POST. Both are stable facts about a
  // deployment, and both must still stop the sending for the rest of the
  // meeting — a message every twenty seconds for an hour is what `permanent`
  // exists to prevent, and none of the 404 work below may cost that.
  {
    const cases = [
      [501, "", "a gateway with no transcription service configured"],
      [405, "", "a route that does not take a POST"],
      [403, ERRORS.forbidden, "a grant that may not write here"],
      [400, ERRORS.invalid, "a request this gateway will never accept"],
    ];
    for (const [status, code, why] of cases) {
      const impl = fakeFetch([{ status, body: code ? { error: code } : {} }]);
      const error = await refusal(transcribeChunk(connection(), request, impl));
      check(`${why} stops the sending`, error instanceof TranscribeRefused && error.permanent === true);
      check(`...and ${status} is a verdict, not a deadline`, error?.notYet === false);
    }
  }

  // -- and the one status that is never a verdict ---------------------------
  //
  // `sessionGone()` answers 404 for three different worlds and cannot tell them
  // apart — another workspace's meeting, one that never existed, and **one that
  // has not been written yet**. That it cannot is the tenant-isolation
  // guarantee rather than a defect. The third is the ordinary case here,
  // because the session row and the audio are two different requests sent by
  // two different mechanisms and this client does not control which lands
  // first. ONE UNLUCKY 404 MUST NEVER DISCARD A MEETING.
  {
    for (const body of [{ error: ERRORS.forbidden }, {}, { error: "something new" }]) {
      const impl = fakeFetch([{ status: 404, body }]);
      const error = await refusal(transcribeChunk(connection(), request, impl));
      check(
        `A 404 IS NOT A PERMANENT REFUSAL (${JSON.stringify(body)})`,
        error instanceof TranscribeRefused && error.permanent === false,
      );
      check("...and is flagged so the caller can put it on a clock", error?.notYet === true);
    }
  }

  // -- and the neighbour a 404 must not swallow -----------------------------
  {
    const denied = fakeFetch([{ status: 403, body: { error: ERRORS.forbidden } }]);
    const forbidden = await refusal(transcribeChunk(connection(), request, denied));
    check(
      "a 403 is the grant being refused, not a meeting that has not landed yet, and stays permanent",
      forbidden?.permanent === true && forbidden?.notYet === false,
    );
  }

  // -- refusals worth trying the next chunk for -----------------------------
  {
    for (const status of [500, 502, 503, 429]) {
      const impl = fakeFetch([{ status, body: { error: ERRORS.unavailable } }]);
      const error = await refusal(transcribeChunk(connection(), request, impl));
      check(`a ${status} is temporary, so the meeting keeps transcribing`, error instanceof TranscribeRefused && error.permanent === false);
    }
  }

  // -- the network -----------------------------------------------------------
  {
    const impl = async () => {
      throw new TypeError("fetch failed: https://gateway.example.test/meetings/... (token=leaky)");
    };
    const error = await refusal(transcribeChunk(connection(), request, impl));
    check("an unreachable gateway is temporary", error instanceof TranscribeRefused && error.permanent === false);
    check(
      "...and its message is this app's own, never the failure's — a fetch error can quote the URL",
      (error?.message ?? "").includes("could not be reached") && !(error?.message ?? "").includes("leaky"),
    );
  }

  // -- a body that is not from a gateway ------------------------------------
  {
    const impl = fakeFetch([() => new Response("<html>captive portal</html>", { status: 200 })]);
    const error = await refusal(transcribeChunk(connection(), request, impl));
    check("a 200 that is not JSON is not a transcript", error instanceof TranscribeRefused);
    check("...and is temporary, because a portal is something a person walks out of", error?.permanent === false);
  }

  // -- a gateway that answered with nothing ---------------------------------
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [] } }]);
    const answer = await transcribeChunk(connection(), request, impl);
    check(
      "an empty answer is an answer: the engine heard nothing",
      Array.isArray(answer.segments) && answer.segments.length === 0,
    );
  }

  /*
    -- WHY THE ANSWER WAS EMPTY, WHICH IS A DIFFERENT QUESTION ----------------

    Since the transcription service began refusing the segments the engine's own
    evidence says are not speech, an empty answer has two causes that need two
    different sentences: a quiet room, and a transcriber that is not working.
    `refusedSegments` is the only thing that tells them apart, so it is read —
    and read carefully, because everything that is *not* a positive number from
    a gateway is read as zero.

    That direction is the whole of the care here. A gateway one deploy behind,
    a proxy that rewrote the body, a string where a number should be: none of
    those is evidence that a room was quiet, and reading them as such would put
    "no speech was heard" on somebody's screen during a meeting they are
    talking in.

    SABOTAGE, each one edit to `main/transcribe.ts`:
      `refusedSegments` dropped from the answer                  2 FAIL
      the whole read replaced by `Number(body.refusedSegments)`  3 FAIL

    The second row is the lazy version of this: it reads a string, a negative
    and a fraction all as refusals, and it is the version somebody writes when
    the field is "obviously just a number".
  */
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [], refusedSegments: 3 } }]);
    const answer = await transcribeChunk(connection(), request, impl);
    check("...and the count that says why it was empty comes back", answer.refusedSegments === 3);
  }
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [], refusedSegments: "lots" } }]);
    const answer = await transcribeChunk(connection(), request, impl);
    check("a refusal count that is not a number is not a refusal", answer.refusedSegments === 0);
  }
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [], refusedSegments: -2 } }]);
    const answer = await transcribeChunk(connection(), request, impl);
    check("...nor is a negative one", answer.refusedSegments === 0);
  }
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [], refusedSegments: 2.9 } }]);
    const answer = await transcribeChunk(connection(), request, impl);
    check("...and a fractional one is a whole number of segments", answer.refusedSegments === 2);
  }
}
