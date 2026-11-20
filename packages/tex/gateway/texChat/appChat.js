/**
 * The app chat's parts of `TexChat` (`packages/tex/gateway/texChat.js`): a chat born in the gateway, never copied in from the
 * texting Worker, and the two calls the gateway's `/tex/app-chat` route makes on it (`agent/appChatRoute.js`).
 *
 * An app chat's name is `app:<userId>` (`packages/tex/worker/appChat.ts`). Its object is placed here at its first call, with
 * no Worker object to move from: the copy `texChat.js` makes for a phone's chat would find nothing to copy. Its line is
 * `appLine`, which texts nobody, so the reply is kept only as the chat object's events, and the page reads them from the
 * ledger and from `GET /app/outbox` (events not yet written to the ledger).
 *
 * The chat's own counts live in its storage: the day's sends and pictures (`SENDS_KEY`), for the daily caps. The words of a
 * send are never kept here beyond the chat object's own outbox.
 */

/** Where the Worker's copy of a chat says it is placed (`packages/tex/worker/inboxMove.ts` `PLACE_KEY`). */
export const PLACE_KEY = "__inbox_place";
/** The name the chat object keeps for itself (`texChat.js`, set by a copy or by this placement). */
export const NAME_KEY = "__inbox_name";
/** The Worker's object id the chat had there, for addresses its pictures and pages are served at: none for an app chat. */
export const SENDER_ID_KEY = "__sender_id";
/** The chat object's outbox: its kept events are stored under this prefix (`packages/tex/worker/events.ts`). */
const EVENT_PREFIX = "ev:";
/** The day's sends: `{ day, n }`, the UTC day and how many sends the chat has taken that day. */
const SENDS_KEY = "app:sends";
/** A person's sends a UTC day, across the app chat (the page's cap, `agent/appChatRoute.js` carries the same number). */
export const APP_DAILY_SENDS = 200;
/** A person's pictures a UTC day, across the app chat: each is kept in the chat's object, which holds at most 10 GB. */
export const APP_DAILY_PICTURES = 60;
/** The app line's typing mark counts as Tex working for this long after it was set. */
export const TYPING_MS = 20_000;

/** Whether a chat name is an app chat's, by the one check the Worker's code makes (`packages/tex/worker/appChat.ts`). */
export async function isAppChatName(name) {
  const { isAppChat } = await import("../../worker/gatewayChat.js");
  return isAppChat(name);
}

/**
 * Places an app chat at its first call: marks it arrived (so no copy is made), and keeps its name. Nothing is written
 * when the chat is already placed, so a later call changes nothing.
 */
export async function placeAppChat(storage, name, now) {
  const place = await storage.get(PLACE_KEY);
  if (place?.arrivedAt !== undefined) return;
  await storage.put(PLACE_KEY, { arrivedAt: now() });
  await storage.put(NAME_KEY, name);
  await storage.put(SENDER_ID_KEY, "");
}

/** The UTC day a time falls on, as `YYYY-MM-DD`: the cap resets at midnight UTC. */
export function utcDay(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * Takes one of the day's sends, or says there is none left. Read and write run inside `blockConcurrencyWhile`, so two
 * sends arriving together cannot both take the last one. Touches no other storage and calls nothing outside.
 */
export function takeSend(state, at, pictures = 0) {
  return state.blockConcurrencyWhile(async () => {
    const day = utcDay(at);
    const kept = await state.storage.get(SENDS_KEY);
    const used = kept?.day === day ? kept.n : 0;
    const pics = kept?.day === day ? (kept.pics ?? 0) : 0;
    if (used >= APP_DAILY_SENDS || pics + pictures > APP_DAILY_PICTURES) return false;
    await state.storage.put(SENDS_KEY, { day, n: used + 1, pics: pics + pictures });
    return true;
  });
}

/** Gives a send back: the chat object refused it, so it does not count against the day. */
export function giveBackSend(state, at, pictures = 0) {
  return state.blockConcurrencyWhile(async () => {
    const day = utcDay(at);
    const kept = await state.storage.get(SENDS_KEY);
    if (kept?.day === day && kept.n > 0) await state.storage.put(SENDS_KEY, { day, n: kept.n - 1, pics: Math.max(0, (kept.pics ?? 0) - pictures) });
  });
}

/** What the app keeps beside one of the person's texts: the pictures it carried, by id (`app:meta:<eventId>`). */
const META_PREFIX = "app:meta:";
/** The person's last tapback on a text, by that text's event id (`app:tap:<eventId>`): `{ emoji, at }`. */
const TAP_PREFIX = "app:tap:";
/** The most pictures one text carries. */
export const MAX_APP_PICTURES = 4;
/** The kinds of call `/app/arrive` passes on, and the chat object's path for each. */
const ARRIVE_PATHS = Object.freeze({ one: "/accept", react: "/react", edit: "/edit" });

/** The provider handles the chat object keeps, each with its event id (`packages/tex/worker/replyQuote.ts` `HANDLES_KEY`). */
async function handlesOf(storage) {
  const { HANDLES_KEY } = await import("../../worker/gatewayChat.js");
  const kept = await storage.get(HANDLES_KEY);
  return Array.isArray(kept) ? kept.filter((entry) => typeof entry?.h === "string" && typeof entry?.ev === "string") : [];
}

/** The event id the chat object logged a message under, found by the handle it came with; null when it kept none. */
export async function eventOfHandle(storage, handle) {
  return (await handlesOf(storage)).find((entry) => entry.h === handle)?.ev ?? null;
}

/** Decodes base64 to bytes, or null when it is not base64. */
function bytesOf(data) {
  if (typeof data !== "string" || data === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Keeps a send's pictures and answers them as the inbound attachments the chat object reads (`attachments.ts`), each
 * at its `app-chat.invalid` address, or null when one is not a picture this chat keeps.
 */
async function keptPictures(storage, pictures, now) {
  const { keepAppPicture, readAppPicture } = await import("../../worker/gatewayChat.js");
  const ids = [];
  const attachments = [];
  for (const [index, data] of pictures.entries()) {
    const bytes = bytesOf(data);
    const id = bytes === null ? null : await keepAppPicture(storage, bytes, now);
    if (id === null) return null;
    const kept = await readAppPicture(storage, id);
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[kept?.mediaType] ?? "jpg";
    ids.push(id);
    attachments.push({ url: `https://app-chat.invalid/pic/${id}.${extension}`, mimeType: kept?.mediaType ?? "image/jpeg", filename: `picture-${index + 1}.${extension}`, size: bytes.byteLength });
  }
  return { ids, attachments };
}

/**
 * `POST /app/arrive`: `{ kind: "one" | "react" | "edit", inbox, message, pictures?, tap? }`, the body the gateway route
 * builds (the shapes Photon's line hands the chat object: `inboundOf` in `labSandbox/chatRun.js`). Every call counts
 * against the day's cap first and is given back if the chat object does not take it.
 *
 *  - `one`: a text, with up to `MAX_APP_PICTURES` pictures (base64), kept here and handed over as attachments. Answers
 *    the event id the object logged it under, and keeps the pictures' ids beside that event for the app to show.
 *  - `react`: a tapback; `tap: { on, emoji }` is kept as the person's last tapback on that event, for the app to show
 *    (`emoji: null` for one taken back).
 *  - `edit`: an edit or an unsend, as `/edit` takes it.
 *
 * Answers `{ outcome, ev? }`; 400 for a picture this chat does not keep, 429 when the day's cap is spent, 503 when the
 * object cannot take it.
 */
export async function serveAppArrive(request, { state, open, now = Date.now }) {
  const body = await request.json().catch(() => null);
  const path = body !== null && typeof body === "object" && !Array.isArray(body) ? ARRIVE_PATHS[body.kind] : undefined;
  if (path === undefined || !Object.hasOwn(ARRIVE_PATHS, body.kind)) return Response.json({ error: "bad_body" }, { status: 400 });
  if (!(await isAppChatName(body.inbox)) || body.message === null || typeof body.message !== "object" || Array.isArray(body.message)) {
    return Response.json({ error: "bad_body" }, { status: 400 });
  }
  // Only this object's own chat: a placed object answers to the name it was placed under, never another.
  const own = await state.storage.get(NAME_KEY);
  if (own !== undefined && own !== body.inbox) return Response.json({ error: "bad_body" }, { status: 400 });
  const pictures = body.kind === "one" && Array.isArray(body.pictures) ? body.pictures : [];
  if (pictures.length > MAX_APP_PICTURES) return Response.json({ error: "bad_body" }, { status: 400 });
  if (!(await takeSend(state, now(), pictures.length))) {
    console.log(JSON.stringify({ event: "app_chat_arrive", kind: body.kind, outcome: "limit" }));
    return Response.json({ outcome: "limit" }, { status: 429 });
  }
  let message = body.message;
  let ids = [];
  if (pictures.length > 0) {
    const kept = await keptPictures(state.storage, pictures, now());
    if (kept === null) {
      await giveBackSend(state, now(), pictures.length);
      return Response.json({ error: "bad_picture" }, { status: 400 });
    }
    ids = kept.ids;
    message = { ...message, attachments: kept.attachments };
  }
  const chat = await open(body.inbox);
  const answer = chat === null ? null : await chat.fetch(new Request(`https://inbox${path}`, { method: "POST", body: JSON.stringify(message) }));
  const ok = answer !== null && answer.ok;
  if (!ok) await giveBackSend(state, now(), pictures.length);
  const outcome = ok ? await answer.json().catch(() => ({})) : {};
  const result = ok ? (typeof outcome.outcome === "string" ? outcome.outcome : "queued") : chat === null ? "not_here" : "failed";
  let ev = null;
  if (ok && body.kind === "one") {
    ev = await eventOfHandle(state.storage, message.messageId);
    // Kept beside the event: its pictures, and the row it replies to (a picture has no words to find it by).
    const replyOn = typeof body.replyOn === "string" && body.replyOn.length <= 64 ? body.replyOn : null;
    if (ev !== null && (ids.length > 0 || replyOn !== null)) await state.storage.put(`${META_PREFIX}${ev}`, { ...(ids.length > 0 ? { pics: ids } : {}), ...(replyOn !== null ? { replyTo: replyOn } : {}) });
  }
  if (ok && body.kind === "react" && typeof body.tap?.on === "string") {
    // A tapback taken back (`emoji: null`) is no longer shown.
    if (typeof body.tap.emoji === "string") await state.storage.put(`${TAP_PREFIX}${body.tap.on}`, { emoji: body.tap.emoji, at: now() });
    else if (body.tap.emoji === null) await state.storage.delete(`${TAP_PREFIX}${body.tap.on}`);
  }
  // An edit the edit node found to change nothing (`same`) is logged nowhere: its words are kept beside the row.
  if (ok && body.kind === "edit" && body.message.kind === "edited" && result === "same" && typeof body.on === "string" && body.on.length <= 64) {
    const kept = (await state.storage.get(`${META_PREFIX}${body.on}`)) ?? {};
    await state.storage.put(`${META_PREFIX}${body.on}`, { ...kept, text: String(body.message.text ?? "").slice(0, 4_000) });
  }
  // An unsent text's pictures are deleted, not only hidden (`forget`: the ids the route found on that text).
  if (ok && body.kind === "edit" && body.message.kind === "unsent" && Array.isArray(body.forget)) {
    const { forgetAppPicture } = await import("../../worker/gatewayChat.js");
    for (const id of body.forget) if (typeof id === "string") await forgetAppPicture(state.storage, id);
  }
  console.log(JSON.stringify({ event: "app_chat_arrive", kind: body.kind, outcome: result, pictures: ids.length }));
  return Response.json({ outcome: result, ...(ev !== null ? { ev } : {}) }, { status: ok ? 200 : 503 });
}

/** `GET /app/picture/<id>`: one of this chat's kept pictures, or 404. */
export async function serveAppPictureById(storage, id) {
  if (!(await isAppChatName(await storage.get(NAME_KEY)))) return new Response(null, { status: 404 });
  const { readAppPicture } = await import("../../worker/gatewayChat.js");
  const kept = await readAppPicture(storage, id);
  if (kept === null) return new Response(null, { status: 404 });
  return new Response(kept.bytes, { headers: { "content-type": kept.mediaType } });
}

/**
 * `GET /app/outbox`: the chat object's kept events that the ledger has not taken yet (never a step, which only the
 * ledger keeps), oldest first; when the app line last showed typing; the pictures and tapbacks the app kept beside
 * events (`metas`, `taps`, by event id); and which events can still be edited (`handles`: event id → the handle an
 * edit names it by). A chat never placed has none of them.
 */
export async function serveAppOutbox(storage, { alarms = null, now = Date.now } = {}) {
  const name = await storage.get(NAME_KEY);
  if (typeof name !== "string") return Response.json({ events: [], typingAt: null, metas: {}, taps: {}, handles: {}, queue: [], failed: {}, stopped: {}, run: null });
  if (!(await isAppChatName(name))) return Response.json({ error: "not_an_app_chat" }, { status: 404 });
  const kept = [...(await storage.list({ prefix: EVENT_PREFIX })).values()];
  const events = kept
    .filter((item) => item && item.w !== true && item.e && item.e.chat === name && item.e.kind !== "step")
    .map((item) => item.e)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { APP_TYPING_KEY } = await import("../../worker/gatewayChat.js");
  const typingAt = await storage.get(APP_TYPING_KEY);
  const byEvent = async (prefix) => Object.fromEntries([...(await storage.list({ prefix })).entries()].map(([key, value]) => [key.slice(prefix.length), value]));
  const handles = Object.fromEntries((await handlesOf(storage)).map((entry) => [entry.ev, entry.h]));
  const { queueView, APP_RUN_KEY } = await import("../../worker/gatewayChat.js");
  const { queue, failed, stopped } = await queueView(storage);
  // The run card of the turn running now (`packages/tex/worker/appRun.ts`): its steps, which texts it answers, when it began.
  const run = (await storage.get(APP_RUN_KEY)) ?? null;
  // A text waiting with no alarm to answer it (one lost with a reset object) is woken by the app's read (`turnWatch.ts`).
  if (alarms !== null && queue.length > 0 && (await alarms.getAlarm()) === null) {
    await alarms.setAlarm(now());
    console.log(JSON.stringify({ event: "app_chat_rearm", waiting: queue.length }));
  }
  return Response.json({ events, typingAt: typeof typingAt === "number" ? typingAt : null, metas: await byEvent(META_PREFIX), taps: await byEvent(TAP_PREFIX), handles, queue, failed, stopped, run });
}

/**
 * `POST /app/stop` (`{}`) and `POST /app/retry` (`{ ev }`): the app's stop and Try again, passed to the chat object
 * (`packages/tex/worker/turnWatch.ts`). Stop answers `{ outcome: "stopped" | "idle", covers }`; retry `{ outcome:
 * "queued" | "none" }`. Only an app chat's object takes them.
 */
export async function serveAppTurnCall(request, path, { state, open }) {
  const name = await state.storage.get(NAME_KEY);
  if (!(await isAppChatName(name))) return Response.json({ error: "not_an_app_chat" }, { status: 404 });
  const body = await request.json().catch(() => ({}));
  const stop = path === "/app/stop";
  if (!stop && (typeof body?.ev !== "string" || body.ev === "" || body.ev.length > 64)) return Response.json({ error: "bad_body" }, { status: 400 });
  const chat = await open(name);
  if (chat === null) return Response.json({ outcome: "not_here" }, { status: 503 });
  const answer = await chat.fetch(new Request(`https://inbox${stop ? "/turn-stop" : "/turn-retry"}`, { method: "POST", body: JSON.stringify(stop ? { chat: name } : { ev: body.ev }) }));
  const outcome = await answer.json().catch(() => ({ outcome: "failed" }));
  console.log(JSON.stringify({ event: "app_chat_turn_call", call: stop ? "stop" : "retry", outcome: outcome.outcome ?? "failed" }));
  return Response.json(outcome, { status: answer.ok ? 200 : 503 });
}
