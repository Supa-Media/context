/**
 * Request-level pieces of the `/collaboration` endpoint: size limits, the
 * head a client syncs from, the caller's identity, bounded body reads and
 * error responses. Moved verbatim out of `src/index.js`; the handler, which
 * authorizes through the privacy engine, stays beside it.
 */

import { supported as collaborationSupported } from "@context/collaboration";
import { json } from "../http/responses.js";

// Collaboration carries a bounded JSON envelope around a bounded Yjs update.
// Keep the request cap above the note cap for base64 and JSON overhead while
// refusing an unbounded body before parsing or handing it to the merge engine.
export const MAX_COLLABORATION_REQUEST_BYTES = 4_000_000;
export const MAX_COLLABORATION_UPDATE_CHARS = 2_900_000;
// Keep this equal to the engine's pre-materialization ceiling. The route
// checks the raw note before initialization and the engine checks the merged
// text before commit, so a successful commit can never become a late 413.
export const MAX_COLLABORATION_NOTE_BYTES = 4 * 1024 * 1024;

/**
 * HTTP collaboration transport.
 *
 * Authentication, workspace selection, storage binding and the initial read
 * scope are established by `route`, exactly as for `/mcp`.  This function is
 * deliberately a small adapter around the collaboration package: privacy is
 * checked before the engine sees a path, and only ordinary Markdown notes are
 * admitted.  The engine owns document identity, merge history and CAS
 * materialization in the customer's bucket.
 */
export async function collaborationHead(store, path) {
  if (!collaborationSupported(store) || !globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const object = await store.get(`.context/collaboration/v1/heads/${hash}.json`);
  if (!object) return null;
  try {
    const head = JSON.parse(await object.text());
    return head && typeof head === "object" ? head : null;
  } catch {
    return null;
  }
}

export function collaborationIdentityFromRequest(body) {
  if (typeof body?.documentId === "string" && body.documentId) return body.documentId;
  const expected = body?.replacement?.expectedEtag;
  const match = typeof expected === "string" ? /^c2\.([A-Za-z0-9-]+)\.r/.exec(expected) : null;
  return match?.[1] ?? null;
}

export function collaborationErrorResponse(error) {
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  if (code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
    return json({ error: code }, 409);
  }
  let message = "";
  try {
    message = error instanceof Error ? String(error.message).toLowerCase() : "";
  } catch {
    message = "";
  }
  if (message.includes("update") || message.includes("base64") || message.includes("invalid")) {
    return json({ error: "invalid_update" }, 400);
  }
  if (message.includes("generation") || message.includes("revision") || message.includes("etag") ||
      message.includes("conflict") || message.includes("base")) {
    return json({ error: "conflict" }, 409);
  }
  return json({ error: "collaboration_unavailable" }, 503);
}

/** Read at most `limit` bytes without buffering an oversized chunked body. */
export async function readBoundedRequestBytes(request, limit) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) return null;
  if (!request.body || typeof request.body.getReader !== "function") {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return bytes.byteLength > limit ? null : bytes;
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
      total += chunk.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The body is already refused; cancellation is best effort.
        }
        return null;
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some test Request bodies do not expose a releasable lock.
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
