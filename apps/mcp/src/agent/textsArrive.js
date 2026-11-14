/**
 * A text arriving at a chat's intake, forwarded from the texting Worker over the `TexTexts` binding to the chat's own
 * Durable Object (`texChat.js`). Nothing here reads a text's words: the body is checked for shape and size, then passed
 * on. The log line carries the kind and the outcome only, never the message and never the inbox name.
 */

import { objectByName } from "../objectPlace.js";
import { INBOX_NAME, isArrival } from "../texChat/arrival.js";

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

/** The prefix of a call the texting Worker's moved chat object passes on (`apps/agent/src/inboxMove.ts` `forward`). */
export const TEXTS_CHAT_CALL_PREFIX = "/texts/chat-call/";

/**
 * A call to a chat the Worker's object has handed over: passed to the chat's own object here, path, query, headers and
 * bytes as they came. The chat is named by the Worker's inbox header, as every call between its objects is.
 */
export async function chatCallForTexts(request, env) {
  const name = request.headers.get("x-inbox-name");
  if (name === null || !INBOX_NAME.test(name)) return Response.json({ error: "bad_request" }, { status: 400 });
  if (!env?.TEX_CHAT) return Response.json({ error: "no_chat_home" }, { status: 501 });
  const url = new URL(request.url);
  const path = url.pathname.slice("/texts".length);
  const stub = objectByName(env.TEX_CHAT, `chat:${name}`);
  const body = request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer();
  return await stub.fetch(new Request(`https://chat${path}${url.search}`, { method: request.method, headers: request.headers, body }));
}
