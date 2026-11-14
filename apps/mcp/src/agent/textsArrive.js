/**
 * A text arriving at a chat's intake, forwarded from the texting Worker over the `TexTexts` binding to the chat's own
 * Durable Object (`texChat.js`). Nothing here reads a text's words: the body is checked for shape and size, then passed
 * on. The log line carries the kind and the outcome only, never the message and never the inbox name.
 */

import { objectByName } from "../objectPlace.js";
import { isArrival } from "../texChat/arrival.js";

/** The path the texting Worker posts to on the `TexTexts` binding. */
export const TEXTS_ARRIVE_PATH = "/texts/arrive";
/** The largest body accepted, in bytes. */
export const MAX_ARRIVE_BYTES = 256 * 1024;

const refused = (status, error, kind, outcome) => {
  console.log(JSON.stringify({ event: "texts_arrive", kind: kind ?? null, outcome }));
  return Response.json({ error }, { status });
};

/** Queues the text in its chat's object, answering the object's outcome: `queued`, `duplicate` or `full`. */
export async function arriveForTexts(request, env) {
  if (request.method !== "POST") return refused(400, "bad_request", null, "bad_request");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_ARRIVE_BYTES) return refused(413, "too_large", null, "too_large");
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refused(400, "bad_body", null, "bad_request");
  }
  if (!isArrival(body)) return refused(400, "bad_body", null, "bad_request");
  if (!env?.TEX_CHAT) return refused(501, "no_chat_home", body.kind, "no_chat_home");
  const stub = objectByName(env.TEX_CHAT, `chat:${body.inbox}`);
  const answer = await stub.fetch("https://chat/arrive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const outcome = await answer.json();
  console.log(JSON.stringify({ event: "texts_arrive", kind: body.kind, outcome: outcome.outcome ?? "error" }));
  return Response.json(outcome, { status: answer.status });
}
