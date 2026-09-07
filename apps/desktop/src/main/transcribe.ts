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
import type { TranscribeRequest } from "../core/capture/gatewayTranscriber.ts";
import type { TranscriptSegment } from "../core/contract.ts";
import type { GatewayConnection } from "../core/sync/connection.ts";

/** A chunk is twenty seconds of speech; a slow link is not a dead one. */
const TIMEOUT_MS = 45_000;

/**
 * Refusals that will answer the same way for every chunk of this meeting.
 *
 * `meeting_forbidden` is the grant, `meeting_invalid` is the request shape, and
 * a 404 is a gateway with no transcription route at all — which is the state
 * every deployment is in until somebody configures one, and precisely the case
 * that must not produce a message every twenty seconds for an hour.
 */
function permanent(status: number, code: string): boolean {
  // The one answer a single reply cannot settle, and the exception is stated
  // first so the two functions below cannot drift into disagreeing. See
  // `sessionUnknown`.
  if (sessionUnknown(status, code)) return false;
  if (status === 404 || status === 405 || status === 501) return true;
  return code === ERRORS.forbidden || code === ERRORS.invalid;
}

/**
 * THE ONE REFUSAL THAT MEANS "NOT YET" AS OFTEN AS IT MEANS "NEVER".
 *
 * `apps/mcp/src/meetings/transcribe.js`'s `sessionGone()` answers **404 with
 * `meeting_forbidden`** for three different worlds and says so in its own
 * comment: another workspace's session, one that never existed, and one that
 * has not been written yet. The third is not an edge case on this path — the
 * session row and the audio are two different requests, sent by two different
 * mechanisms (the outbox and this file), and this client does not control which
 * lands first. It is the shape of a race, not of a permission.
 *
 * Read as permanent, one such answer discards **the entire meeting's audio**:
 * `gatewayTranscriber` sets `givenUp` and silently drops every remaining chunk,
 * including all the ones that would have succeeded the moment the session
 * arrived. That is what shipped, and with `SEGMENT_MS` (20 s) under
 * `DRAIN_INTERVAL_MS` (30 s) it happened on the first chunk of every recording.
 *
 * So it is **not permanent** — one reply cannot make it so — and it is carried
 * as its own fact besides, so the caller can spend a small budget of them before
 * concluding "never". Both, rather than either: dropping it out of `permanent`
 * alone would leave a genuinely forbidden meeting uploading a full chunk of
 * audio every twenty seconds for its whole length, and carrying only the extra
 * flag would leave `permanent` asserting something a single answer cannot know —
 * which is how the next reader of that bit alone loses a meeting again.
 *
 * Deliberately narrow. A **bare** 404 — no meetings error code — is still
 * permanent and still means "this gateway has no transcription route", which is
 * a different sentence about a different thing. So is a 403 with
 * `meeting_forbidden`, which is the grant being refused rather than the meeting
 * being unknown.
 */
function sessionUnknown(status: number, code: string): boolean {
  return status === 404 && code === ERRORS.forbidden;
}

export async function transcribeChunk(
  connection: GatewayConnection,
  request: TranscribeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscriptSegment[]> {
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
        sessionUnknown(response.status, code),
      );
    }

    const body = (await response.json()) as { segments?: unknown };
    return Array.isArray(body.segments) ? (body.segments as TranscriptSegment[]) : [];
  } catch (error) {
    if (error instanceof TranscribeRefused) throw error;
    // A network failure, a timeout, or a body that was not JSON. All temporary,
    // all worth trying the next chunk for.
    throw new TranscribeRefused("the gateway could not be reached", false);
  } finally {
    clearTimeout(timeout);
  }
}
