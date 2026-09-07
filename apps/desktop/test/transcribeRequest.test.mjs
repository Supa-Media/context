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
 *   a 404 classified as temporary (a message every twenty seconds)             1
 *   every refusal classified as permanent (one blip ends the transcript)       4
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
    const segments = await transcribeChunk(connection(), request, impl);
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
  }

  // -- an unconnected machine sends nothing ---------------------------------
  {
    const impl = fakeFetch([{ status: 200, body: { segments: [] } }]);
    const error = await refusal(transcribeChunk(connection(null), request, impl));
    check("a machine with no token does not post audio at all", impl.calls.length === 0);
    check("...and says so as a refusal that will not change this meeting", error instanceof TranscribeRefused && error.permanent === true);
  }

  // -- refusals that will answer the same way forever ------------------------
  {
    const cases = [
      [404, "", "a gateway with no transcription route"],
      [403, ERRORS.forbidden, "a grant that may not write here"],
      [400, ERRORS.invalid, "a request this gateway will never accept"],
    ];
    for (const [status, code, why] of cases) {
      const impl = fakeFetch([{ status, body: code ? { error: code } : {} }]);
      const error = await refusal(transcribeChunk(connection(), request, impl));
      check(`${why} stops the sending`, error instanceof TranscribeRefused && error.permanent === true);
    }
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
    const segments = await transcribeChunk(connection(), request, impl);
    check("an empty answer is an answer: the engine heard nothing", Array.isArray(segments) && segments.length === 0);
  }
}
