/** The forwarder that relays meeting audio to the transcription service. Moved verbatim out of `src/index.js`. */

/* -------------------------------- meetings -------------------------------- */

/**
 * Write one meeting note into the customer's bucket.
 *
 * `src/meetings/` decides what a meeting is, what Markdown it renders to, and
 * which path it claims. This decides what *writing a note* means here, and it
 * is deliberately the only thing the meeting handlers are given: a second
 * answer to "what visibility does a new note get" is where privacy bugs come
 * from, so the meeting path gets the same three rules every other write obeys.
 *
 *  - **A meeting note is a note.** Its visibility is `privacy.md`'s to decide,
 *    by folder default and exact override, exactly as `write_note`'s is. There
 *    is no meeting-shaped bypass and nothing here consults the session's own
 *    idea of who was in the room.
 *  - **A personal connection's new note is private**, and the override is
 *    written *before* the content, so there is no window in which the words are
 *    in the bucket at a wider visibility than they will end up at.
 *  - **A team connection may only create team content, in a folder whose
 *    default is already team.** The same two refusals `toolWriteNote` gives,
 *    for the same reason: a connection that cannot see private content must not
 *    be able to create it either, and a destination outside the team-writable
 *    surface is refused without saying what is there.
 *
 * The audit record carries the acting identity through `store.actor`, the path,
 * the visibility and how many segments the transcript held — and no title, no
 * attendees and no transcript. What was said in a meeting is note content, and
 * `.context/audit/` is a record of actions on paths.
 */
/**
 * The transcription service this deployment is configured with, or `null`.
 *
 * ## Two variables, or nothing at all
 *
 * `TRANSCRIBE_WORKER_URL` and `TRANSCRIBE_WORKER_SECRET`, both or neither. A
 * URL with no secret would post somebody's meeting audio to an endpoint
 * unauthenticated, which is worse than the refusal it replaces; a secret with
 * no URL is a deployment that thinks it is configured and is not. Absent is a
 * first-class state: the route answers 501 and every recorder degrades to typed
 * notes, which is exactly what a self-hoster who has not set this up should get.
 *
 * The URL must be `https`. It is where audio goes.
 *
 * ## What crosses, and what deliberately does not
 *
 * The audio, its container, and how long it is. **Not** the session id, not the
 * chunk id, not the workspace id and not the note it will become: a stateless
 * transcriber that also knew where a chunk sat in a recording would be holding
 * a fragment of somebody's meeting, and `infra/transcribe-worker` is built so
 * that it cannot. The offsets and the ids are added back on this side, where
 * they came from.
 *
 * `X-Caller-Hash` is the one identifier that travels, and it is an **HMAC of
 * the workspace id under the shared secret** rather than the id. It exists so a
 * surprising bill has an account behind it and so the service can bound one
 * account's spend; it is not reversible by anyone who does not already hold the
 * secret, and holding the secret is what being that service means. Same
 * construction, for the same reason, as the control plane's `callerHash`.
 *
 * Nothing here logs the audio, its length, or the words that come back. A
 * transcript is note content, and the standard is that logs never carry it.
 */
export function transcriptionForwarder(env) {
  const endpoint = typeof env?.TRANSCRIBE_WORKER_URL === "string" ? env.TRANSCRIBE_WORKER_URL.trim() : "";
  const secret = typeof env?.TRANSCRIBE_WORKER_SECRET === "string" ? env.TRANSCRIBE_WORKER_SECRET.trim() : "";
  if (!endpoint || !secret) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const target = new URL("transcribe", url.href.endsWith("/") ? url.href : `${url.href}/`).href;

  return async ({ audioBase64, mimeType, durationMs, callerId }) => {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "X-Caller-Hash": await callerHash(callerId, secret),
      },
      body: JSON.stringify({ audioBase64, mimeType, durationMs }),
    });
    if (!response.ok) {
      // The status and nothing else. Never the body: it is the far end's prose
      // about a request that carried audio.
      console.warn(JSON.stringify({ event: "transcribe_upstream", status: response.status }));
      throw new Error(`transcription answered ${response.status}`);
    }
    /*
      The whole answer, not just its segments.

      It used to be `payload?.segments`, which threw away the one field that
      says why an answer is short: `refused` is how many segments the service
      dropped because the engine's own evidence said they were not speech. An
      empty transcript with `refused: 3` is a quiet room and one with
      `refused: 0` is a broken engine, and a caller that cannot tell them apart
      shows the wrong sentence for one of them. See
      `infra/transcribe-worker/src/transcribe.ts`.
    */
    return await response.json();
  };
}

/**
 * Who is spending, opaquely.
 *
 * HMAC-SHA256 of the workspace id under the shared secret, hex. Not the id, and
 * not a hash anybody without the secret can build a rainbow table for.
 */
async function callerHash(workspaceId, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(workspaceId)));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
