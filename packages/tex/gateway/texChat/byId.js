/**
 * A text chat found by the id its addresses carry. A picture Tex sends (`/media/<id>/<token>`, fetched by the line to
 * send it) and a page of a chat's jobs (`/threads/<id>/<token>`) name the chat by its object's id in the texting Worker,
 * kept by the chat's copy here as its sender id (`texChat.js` `chatState`). Part C of the runtime simplification (Dev2
 * approved https://claude.ai/artifact/AcEGnAtBKWqeTAcXa1vveX) deletes that Worker object, so the gateway keeps its own
 * index: one `TexChat` object per id, `byid:<id>`, holding the chat's name, written when the chat opens here or is asked
 * its home (the intake sweep asks every chat, so one sweep indexes every chat already moved).
 *
 * The id is only a locator: the chat still checks the address's token, so knowing an id reads nothing.
 */

/** An index object's name: a Worker object id, 64 hex. */
const BY_ID_NAME = /^byid:[0-9a-f]{64}$/;
/** A Worker object id. */
export const OBJECT_ID = /^[0-9a-f]{64}$/;
/** The path an index object answers. */
export const BY_ID_PATH = "/by-id";
/** Kept in a chat's own storage once its index is written, so it is written once. */
const INDEXED_KEY = "__by_id_indexed";

/** The index object's name for a chat's sender id. */
export function byIdName(senderId) {
  return `byid:${senderId}`;
}

/** Whether this object's name (from the caller's `x-inbox-name`, or none) is an index object's. */
export function isByIdName(name) {
  return typeof name === "string" && BY_ID_NAME.test(name);
}

/**
 * One call to an index object: GET reads the chat's name (404 when none), POST `{ name }` keeps it. A name already
 * kept is never replaced: an id belongs to one chat for good.
 */
export async function serveById(request, storage) {
  const { NAME_KEY } = await import("./appChat.js");
  if (request.method === "GET") {
    const name = await storage.get(NAME_KEY);
    return typeof name === "string" ? Response.json({ name }) : Response.json({ error: "not_found" }, { status: 404 });
  }
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const body = await request.json().catch(() => null);
  const { INBOX_NAME } = await import("./arrival.js");
  if (typeof body?.name !== "string" || !INBOX_NAME.test(body.name)) return new Response(null, { status: 400 });
  const kept = await storage.get(NAME_KEY);
  if (kept === undefined) await storage.put(NAME_KEY, body.name);
  else if (kept !== body.name) return Response.json({ error: "taken" }, { status: 409 });
  return Response.json({ ok: true });
}

/**
 * Writes this chat's index entry once: `storage` is the chat's own, `senderId` the id its addresses carry. An id that
 * is not a Worker object's (an app chat's is empty) has nothing to index. A failure is logged and tried again on the
 * next open; it never stops the chat.
 */
export async function indexChat(env, storage, name, senderId) {
  if (env?.TEX_CHAT === undefined || typeof name !== "string" || typeof senderId !== "string" || !OBJECT_ID.test(senderId)) return;
  if ((await storage.get(INDEXED_KEY)) === true) return;
  const { objectByName } = await import("../../../../apps/mcp/src/objectPlace.js");
  const answer = await objectByName(env.TEX_CHAT, byIdName(senderId))
    .fetch(`https://chat${BY_ID_PATH}`, { method: "POST", headers: { "content-type": "application/json", "x-inbox-name": byIdName(senderId) }, body: JSON.stringify({ name }) })
    .catch(() => null);
  if (answer?.ok) {
    await storage.put(INDEXED_KEY, true);
    return;
  }
  console.log(JSON.stringify({ event: "tex_chat_by_id", outcome: "index_failed", status: answer?.status ?? 0 }));
}

/** The texting Worker's door to a chat by id, on `TexTexts`. */
export const TEXTS_CHAT_BY_ID_PREFIX = "/texts/chat-by-id/";

/** The paths a chat answers by id: a picture and a jobs page, each behind its own token. */
const BY_ID_CALLS = /^\/(media|threads)\/[0-9a-f]{64}$/;

/**
 * The texting Worker's `/media` and `/threads` door (`TexTexts` `/texts/chat-by-id/<id>/<media|threads>/<token>`): the
 * index names the chat, and the chat's own object answers the call through its `/chat-call` door, as a call by name
 * would. GET only; an id nobody indexed, or any other path, is the same 404.
 */
export async function chatByIdForTexts(request, env) {
  const path = new URL(request.url).pathname.slice(TEXTS_CHAT_BY_ID_PREFIX.length - 1);
  if (request.method !== "GET") return new Response(null, { status: 405 });
  if (env?.TEX_CHAT === undefined) return Response.json({ error: "no_chat_home" }, { status: 501 });
  const match = /^\/([0-9a-f]{64})(\/.*)$/.exec(path);
  if (match === null || !BY_ID_CALLS.test(match[2])) return new Response(null, { status: 404 });
  const { objectByName } = await import("../../../../apps/mcp/src/objectPlace.js");
  const index = await objectByName(env.TEX_CHAT, byIdName(match[1])).fetch(`https://chat${BY_ID_PATH}`, { headers: { "x-inbox-name": byIdName(match[1]) } });
  if (!index.ok) return new Response(null, { status: 404 });
  const { name } = await index.json();
  return await objectByName(env.TEX_CHAT, `chat:${name}`).fetch(`https://chat/chat-call${match[2]}`, { headers: { "x-inbox-name": name } });
}
