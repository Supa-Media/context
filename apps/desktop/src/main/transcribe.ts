/**
 * One chunk of audio, posted to the gateway, in the main process only.
 *
 * The renderer that holds the microphone hands its bytes to the main process
 * and stops there: the credential lives here, `preload` exposes no channel that
 * reads it, and a window that could reach the gateway itself would be a window
 * that could be handed a token. So this is the one place audio meets a network.
 *
 * Everything about *when* to send, what to do with a refusal and how many may
 * be outstanding is `core/capture/gatewayTranscriber.ts`'s, which is a pure
 * module with checks. This file is the request.
 *
 * ## What it must never do
 *
 * **Log the audio, or anything derived from it.** Not the base64, not its
 * length, not the transcript that comes back — a transcript is note content and
 * the engineering standards say logs never carry that. The only thing that
 * would ever be worth logging here is a status code, and the caller already
 * turns one into a sentence.
 *
 * **Put the credential anywhere but the header.** Same rule as `sync/client.ts`,
 * and for the same reason: this URL is composed from a stored base URL and a
 * contract route, and a token in it would land in every proxy log on the way.
 */

import { ERRORS, ROUTES } from "../core/contract.ts";
import { TranscribeRefused } from "../core/capture/gatewayTranscriber.ts";
import type { TranscribeAnswer, TranscribeRequest } from "../core/capture/gatewayTranscriber.ts";
import type { TranscriptSegment } from "../core/contract.ts";
import type { GatewayConnection } from "../core/sync/connection.ts";

/** A chunk is twenty seconds of speech; a slow link is not a dead one. */
const TIMEOUT_MS = 45_000;

/**
 * Refusals that will answer the same way for every chunk of this meeting.
 *
 * **405 and 501 are the permanent ones, and 404 is deliberately not.** 501 is
 * this gateway's own documented answer for "no transcription service is
 * configured here" — `apps/mcp/src/meetings/transcribe.js` throws it by name,
 * for exactly the reason that a client must not ask again every twenty seconds
 * for an hour — and 405 is a route that exists and does not take a POST. Both
 * are stable facts about a deployment.
 *
 * `meeting_forbidden` on any other status is the grant, and `meeting_invalid`
 * is the request shape. Both stay permanent.
 */
function permanent(status: number, code: string): boolean {
  if (status === 405 || status === 501) return true;
  // A 404 is never settled by one reply. See `notYet`.
  if (notYet(status)) return false;
  return code === ERRORS.forbidden || code === ERRORS.invalid;
}

/**
 * "I DO NOT KNOW THAT", WHICH ON THIS PATH IS AS OFTEN "NOT YET".
 *
 * `apps/mcp/src/meetings/transcribe.js`'s `sessionGone()` answers **404** for
 * three different worlds and says so in its own comment: another workspace's
 * session, one that never existed, and one that has not been written yet. That
 * it cannot tell them apart **is the tenant-isolation guarantee, not a defect**
 * — one code for "not yours" and "not there" is what stops a caller
 * enumerating another workspace's meetings by watching which id answers
 * differently. The gateway is right; the ordering belongs on this side.
 *
 * And the third world is the ordinary one here, because the session row and the
 * audio are two different requests sent by two different mechanisms — the
 * outbox and this file — and this client does not control which lands first.
 * That is the shape of a race, not of a permission.
 *
 * Read as permanent, one such answer discarded **the entire meeting's audio**:
 * `gatewayTranscriber` set `givenUp` and silently dropped every remaining
 * chunk, including all the ones that would have succeeded the moment the row
 * arrived. With `SEGMENT_MS` (20 s) under `DRAIN_INTERVAL_MS` (30 s) that
 * happened on the first chunk of every recording ever made.
 *
 * So **every** 404 is provisional, not only the one carrying
 * `meeting_forbidden`. A bare 404 from a proxy, a gateway too old to have this
 * route, a captive portal answering plausibly — none of those is worth a
 * meeting, and 501 is the answer a deployment that genuinely has no
 * transcription gives. **One unlucky 404 must never discard a meeting.** The
 * caller bounds it on a clock instead; see `NOT_YET_GRACE_MS`.
 */
function notYet(status: number): boolean {
  return status === 404;
}

export async function transcribeChunk(
  connection: GatewayConnection,
  request: TranscribeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscribeAnswer> {
  const token = await connection.token();
  const baseUrl = connection.baseUrl();
  if (token === null || baseUrl === null) {
    // Not connected, or a credential that has expired and could not be renewed.
    // Permanent for this meeting: the alternative is asking the keychain and the
    // network again every twenty seconds while recording audio nobody will read.
    throw new TranscribeRefused("this machine cannot authenticate to its context", true);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}${ROUTES.transcribe(request.sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        audioBase64: request.audioBase64,
        mimeType: request.mimeType,
        chunkId: request.chunkId,
        offsetMs: request.offsetMs,
        durationMs: request.durationMs,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      const code = typeof body.error === "string" ? body.error : "";
      // Deliberately not the server's own prose: `gatewayTranscriber` has a
      // closed set of sentences and this is one of the inputs to it.
      throw new TranscribeRefused(
        `the gateway refused a chunk (${response.status})`,
        permanent(response.status, code),
        notYet(response.status),
      );
    }

    const body = (await response.json()) as { segments?: unknown; refusedSegments?: unknown };
    return {
      segments: Array.isArray(body.segments) ? (body.segments as TranscriptSegment[]) : [],
      /*
        HOW MANY SEGMENTS THE ENGINE SAID WERE NOT SPEECH.

        Zero for anything unreadable, and that direction is the whole of the
        care in this line: a gateway too old to send the field, a proxy that
        rewrote the body, a number that is not one — none of those is evidence
        that a room was quiet, and reading them as such would put a sentence
        about silence on a screen during a meeting somebody is talking in.
      */
      refusedSegments:
        typeof body.refusedSegments === "number" &&
        Number.isFinite(body.refusedSegments) &&
        body.refusedSegments > 0
          ? Math.floor(body.refusedSegments)
          : 0,
    };
  } catch (error) {
    if (error instanceof TranscribeRefused) throw error;
    // A network failure, a timeout, or a body that was not JSON. All temporary,
    // all worth trying the next chunk for.
    throw new TranscribeRefused("the gateway could not be reached", false);
  } finally {
    clearTimeout(timeout);
  }
}
