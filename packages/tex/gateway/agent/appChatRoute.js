/**
 * `POST /tex/app-chat`: the Context app's chat with Tex (decision `docs/decisions/texting-assistant/app-chat.md`), one
 * person's 1:1 with Tex in the app. The app is one more line into the person's chat with Tex: its own chat, with the
 * same history (Dev2, 2026-11-19: "like whatsapp its own thing, but it can see the same history"). This route only hands
 * the app chat's object what Photon's line would hand a chat object (`labSandbox/chatRun.js` `inboundOf`'s shapes) and
 * reads back what was said from the ledger and the outbox (`appChatRows.js`).
 *
 * Who may: only the console's own client (`context_console`, which the control plane mints for a signed-in person and
 * never registers), for a personal workspace the person owns. The chat is always `app:<session.actorUserId>`: nothing
 * in the body names a chat, a user or a workspace, and every id the body names is checked against this chat's rows.
 *
 *  - `{ op: "get" }` → `{ rows, typing }`: the newest rows, oldest first, and whether Tex is working.
 *  - `{ op: "send", text?, pictures?, replyTo? }` → `{ msgId }`: words (trimmed, up to 4000 characters) and up to four
 *    pictures (base64 JPEG, PNG, GIF or WebP, each up to 5 MB; the bytes decide the kind), at least one of the two.
 *    `replyTo` names a row of this chat (its words are quoted, as a Messages reply's are).
 *  - `{ op: "react", msgId, emoji }` → `{ msgId }`: one of Messages' six tapbacks on a row, as Photon's line hands one
 *    over. 👍 or 👎 on Tex's text with an open ask settles it (`thumbsUpIsYes`), exactly as a texted tapback does. The
 *    same tapback again takes it back, as in Messages.
 *  - `{ op: "edit", msgId, text }` / `{ op: "unsend", msgId }` → `{ msgId }`: the person's own text, while it is
 *    `editable` (words) or `unsendable` (any of theirs), for 15 minutes as in Messages, as Photon's line hands an edit or an unsend (node `edit`).
 *  - `{ op: "picture", id }` → the picture's bytes: one shown in this chat's rows, never another's.
 *  - `{ op: "warm", cause: "open" | "typing" }` → `{ when, why? }`: the person opened the chat or started typing, so
 *    the model's cache is warmed for their next text when node `warm` is wired (`textsWarm.js`); a skip otherwise.
 *
 * Every call but `get` and `picture` counts against the chat's daily cap (`texChat/appChat.js`). Nothing here is logged
 * but the operation and the outcome: never the words, an id or a row.
 */

import { ledgerFor, ONE_TO_ONE_CHAT } from "./ledger.js";
import { objectByName } from "../../../../apps/mcp/src/objectPlace.js";
import { ROWS_SHOWN, buildRows, ledgerEntries, outboxOf, typingNow } from "./appChatRows.js";

export const APP_CHAT_PATH = "/tex/app-chat";
/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";
/** A send's text, after trimming. */
export const MAX_APP_TEXT = 4_000;
/** The request body's largest size, in bytes: four 5 MB pictures in base64, and the words. */
const MAX_BODY_BYTES = 28 * 1024 * 1024;
/** The most pictures one send carries (`texChat/appChat.js` `MAX_APP_PICTURES`). */
export const MAX_APP_PICTURES = 4;
/** A picture's largest size in base64: 5 MB of bytes. */
const MAX_PICTURE_BASE64 = Math.ceil((5_000_000 * 4) / 3) + 4;
/** The words of a tapback's text, as a Photon tapback's are kept (`inboundOf`). */
const MAX_REACTION_WORDS = 1_000;
/** Messages' six tapbacks, by the emoji the app sends, named as the Worker reads them (`reactions.ts`). */
const TAPBACKS = new Map([["❤️", "Loved"], ["👍", "Liked"], ["👎", "Disliked"], ["😂", "Laughed at"], ["‼️", "Emphasized"], ["❓", "Questioned"]]);
/** The picture kinds served back (`packages/tex/worker/appPictures.ts`): none can carry a script. */
const PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const LIMIT_MESSAGE = "That's today's limit for the app chat. Try again tomorrow.";
const UNREACHABLE_MESSAGE = "Tex can't take that just now. Try again in a moment.";
const READ_MESSAGE = "The chat could not be read just now. Try again in a moment.";

const json = (body, status = 200) => Response.json(body, { status });
const refuse = (status, error) => json({ error }, status);

/** A random event id for a message or a tapback: `app:` and 16 hex digits, the same shape as a Photon event's. */
function eventIdOf() {
  return `app:${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The route. `deps` is for the tests only: `ledgerOf` (`ledgerFor`) and `now` (`Date.now`); the route reads the chat
 * object through `env.TEX_CHAT`, as `textsArrive.js` does.
 */
export async function handleAppChat(request, store, session, path, env, deps = {}) {
  // The console is another origin (context.lc) than the gateway, so every answer, a refusal included, carries the
  // gateway's open CORS header, as `/approvals`' do; without it the browser hides a 200 and the app says it could
  // not reach Tex (Dev2, 2026-11-19). The bearer token, never a cookie, is what admits a request.
  const answer = await serveAppChat(request, store, session, path, env, deps);
  const out = new Response(answer.body, answer);
  out.headers.set("Access-Control-Allow-Origin", "*");
  return out;
}

async function serveAppChat(request, _store, session, _path, env, deps = {}) {
  const { ledgerOf = (owner) => ledgerFor(env, owner), now = Date.now } = deps;
  if (session?.actorClientId !== CONSOLE_CLIENT_ID || session.workspaceKind !== "personal" || session.role !== "owner") {
    return refuse(403, "forbidden");
  }
  // The chat is the session's own user's, and only when that id is one the app's chats take (`appChat.ts`).
  if (typeof session.actorUserId !== "string") return refuse(403, "forbidden");
  const { isAppChat } = await import("../../worker/gatewayChat.js");
  const chatId = `app:${session.actorUserId}`;
  if (!isAppChat(chatId)) return refuse(403, "forbidden");
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // Refused on its stated length before a byte is read; the read itself is checked again below.
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return refuse(413, "The request is too large.");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) return refuse(413, "The request is too large.");
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refuse(400, "The request is not JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return refuse(400, "Send a JSON object with an op.");
  if (env?.TEX_CHAT === undefined) return refuse(503, UNREACHABLE_MESSAGE);
  const ctx = { env, chatId, session, ledgerOf, now };
  try {
    if (body.op === "get") return await get(ctx);
    if (body.op === "send") return await send(ctx, body);
    if (body.op === "react") return await react(ctx, body);
    if (body.op === "edit" || body.op === "unsend") return await edit(ctx, body);
    if (body.op === "picture") return await picture(ctx, body);
    if (body.op === "warm") return await warm(ctx, body);
    return refuse(400, "op is get, send, react, edit, unsend, picture or warm.");
  } catch (error) {
    // The error's name only: a read's message can carry the words it read.
    console.log(JSON.stringify({ event: "app_chat", op: String(body.op), outcome: "unreachable", error: String(error?.name ?? "error").slice(0, 40) }));
    return refuse(503, READ_MESSAGE);
  }
}

/** Every row of the chat, oldest first, with the outbox's typing mark: the one read a `get`, `send`'s reply and `react`'s check all need. */
async function readChat({ env, chatId, session, ledgerOf, now }) {
  const [ledger, outbox] = await Promise.all([ledgerEntries(ledgerOf, session.workspaceId), outboxOf(env.TEX_CHAT, chatId)]);
  const out = {};
  const rows = buildRows(ledger, outbox, now(), out);
  return { rows, typing: typingNow(outbox.typingAt, now()), handles: out.handles };
}

/** They opened the chat or started typing: node `warm` for their own 1:1's home (`textsWarm.js`); nothing of theirs is read here. */
async function warm({ env, session }, body) {
  if (body.cause !== "open" && body.cause !== "typing") return refuse(400, "cause is open or typing.");
  const { warmChat } = await import("./textsWarm.js");
  const out = await warmChat(env, { owner: { person: session.workspaceId }, chat: ONE_TO_ONE_CHAT }, body.cause);
  console.log(JSON.stringify({ event: "app_chat", op: "warm", outcome: out.when?.[0] ?? "skip" }));
  return json({ when: out.when, ...(out.why ? { why: out.why } : {}) });
}

async function get(ctx) {
  const { rows, typing } = await readChat(ctx);
  console.log(JSON.stringify({ event: "app_chat", op: "get", outcome: "ok" }));
  return json({ rows: rows.slice(-ROWS_SHOWN), typing });
}

async function send(ctx, body) {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length > MAX_APP_TEXT) return refuse(400, `Write up to ${MAX_APP_TEXT} characters.`);
  const pictures = body.pictures === undefined ? [] : body.pictures;
  if (!Array.isArray(pictures) || pictures.length > MAX_APP_PICTURES || !pictures.every((data) => typeof data === "string" && data.length > 0 && data.length <= MAX_PICTURE_BASE64)) {
    return refuse(400, `Send up to ${MAX_APP_PICTURES} pictures, each up to 5 MB.`);
  }
  if (text === "" && pictures.length === 0) return refuse(400, "Write something or add a picture.");
  let replied = null;
  if (body.replyTo !== undefined) {
    if (typeof body.replyTo !== "string") return refuse(400, "replyTo is the id of a text in this chat.");
    replied = (await readChat(ctx)).rows.find((row) => row.id === body.replyTo && !row.unsent) ?? null;
    if (replied === null) return refuse(400, "That text is not in this chat.");
  }
  const eventId = eventIdOf();
  // The same shape Photon's inbound message takes (`labSandbox/chatRun.js` `inboundOf`): the quoted words only when the reply has any.
  const message = {
    kind: "message",
    eventId,
    chatId: ctx.chatId,
    from: ctx.chatId,
    messageId: eventId,
    text,
    ...(replied !== null ? { ...(replied.text ? { quoted: replied.text } : {}), threaded: true } : {}),
  };
  return await arrive(ctx, { kind: "one", message, ...(pictures.length > 0 ? { pictures } : {}), ...(replied !== null ? { replyOn: replied.id } : {}) }, eventId);
}

async function react(ctx, body) {
  const how = typeof body.emoji === "string" ? TAPBACKS.get(body.emoji) : undefined;
  if (how === undefined) return refuse(400, "A tapback is one of ❤️ 👍 👎 😂 ‼️ ❓.");
  if (typeof body.msgId !== "string") return refuse(400, "msgId is the id of a text in this chat.");
  const target = (await readChat(ctx)).rows.find((row) => row.id === body.msgId && !row.unsent && (row.text.trim() !== "" || (row.pics?.length ?? 0) > 0));
  if (target === undefined) return refuse(400, "That is not a text in this chat.");
  const eventId = eventIdOf();
  // The same tapback again takes it back, as in Messages (`inbox.ts` `react`: a removed 👍 drops a held yes).
  // Never from an answer to an ask (`answer: true`): Approve twice must not take the yes back.
  const removed = body.answer !== true && (target.reactions ?? []).some((reaction) => reaction.who === "me" && reaction.emoji === body.emoji);
  // On Tex's text, its words, as Photon's `targetFromMe` reads one; on the person's own, none (`inboundOf`).
  const on = target.who === "tex" ? { words: target.text.trim().slice(0, MAX_REACTION_WORDS), onTex: true } : { words: "", onOther: true };
  const reaction = { how, ...on, ...(removed ? { removed: true } : {}) };
  const message = { kind: "reaction", eventId, chatId: ctx.chatId, from: ctx.chatId, messageId: eventId, reaction };
  return await arrive(ctx, { kind: "react", message, tap: { on: target.id, emoji: removed ? null : body.emoji } }, body.msgId);
}

async function edit(ctx, body) {
  const unsend = body.op === "unsend";
  if (typeof body.msgId !== "string") return refuse(400, "msgId is the id of one of your texts in this chat.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!unsend && (text === "" || text.length > MAX_APP_TEXT)) return refuse(400, `Write 1 to ${MAX_APP_TEXT} characters.`);
  const { rows, handles } = await readChat(ctx);
  const target = rows.find((row) => row.id === body.msgId && (unsend ? row.unsendable === true : row.editable === true));
  const handle = target === undefined ? undefined : handles[target.id];
  if (target === undefined || typeof handle !== "string") return refuse(400, "Only your own texts from the last 15 minutes can be changed.");
  if (!unsend && text === target.text) return json({ msgId: target.id });
  const eventId = eventIdOf();
  // Photon's edit or unsend, as its line hands one to the chat object (`inboundOf`): the text named by the handle it came with.
  const message = {
    kind: unsend ? "unsent" : "edited",
    eventId,
    chatId: ctx.chatId,
    from: ctx.chatId,
    messageId: handle,
    ...(unsend ? {} : { text, previous: target.text }),
    at: new Date(ctx.now()).toISOString(),
  };
  return await arrive(ctx, { kind: "edit", message, on: target.id, ...(unsend && (target.pics?.length ?? 0) > 0 ? { forget: target.pics } : {}) }, target.id);
}

async function picture(ctx, body) {
  if (typeof body.id !== "string") return refuse(400, "id is a picture in this chat.");
  // Only a picture this chat's rows show: an id from anywhere else is never looked up.
  const shown = (await readChat(ctx)).rows.some((row) => (row.pics ?? []).includes(body.id));
  if (!shown) return refuse(404, "There is no such picture in this chat.");
  const answer = await objectByName(ctx.env.TEX_CHAT, `chat:${ctx.chatId}`).fetch(new Request(`https://chat/app/picture/${body.id}`));
  const type = answer.headers.get("content-type") ?? "";
  if (!answer.ok || !PICTURE_TYPES.has(type)) return refuse(404, "There is no such picture in this chat.");
  return new Response(answer.body, {
    headers: {
      "content-type": type,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/** Hands the chat object one call, through `POST /app/arrive` on the chat's object; the answer's status is the route's. */
async function arrive({ env, chatId }, call, msgId) {
  const stub = objectByName(env.TEX_CHAT, `chat:${chatId}`);
  const answer = await stub.fetch(new Request("https://chat/app/arrive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...call, inbox: chatId }) }));
  const op = { one: "send", react: "react", edit: call.message.kind === "unsent" ? "unsend" : "edit" }[call.kind];
  console.log(JSON.stringify({ event: "app_chat", op, outcome: answer.status }));
  if (answer.status === 429) return refuse(429, LIMIT_MESSAGE);
  if (answer.status === 400) return refuse(400, call.kind === "one" ? "A picture is JPEG, PNG, GIF or WebP, up to 5 MB." : "That could not be sent.");
  if (!answer.ok) return refuse(503, UNREACHABLE_MESSAGE);
  const said = await answer.json().catch(() => ({}));
  // A send answers the event id the chat logged it under, which its row will carry; otherwise the id the call named.
  return json({ msgId: typeof said?.ev === "string" ? said.ev : msgId });
}
