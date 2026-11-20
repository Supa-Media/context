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
/**
 * A person's pictures and files a UTC day, across the app chat: each is kept in the chat's object, which holds at most
 * 10 GB. A file counts as a picture does, so the one cap holds both.
 */
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
 * Keeps a send's pictures and files, and answers them as the inbound attachments the chat object reads (`attachments.ts`),
 * each at its `app-chat.invalid` address: the pictures first, then the files. Null when one is not a kind this chat
 * keeps; what was kept of the send is then taken back, so nothing is left behind.
 */
async function keptAttachments(storage, pictures, files, now) {
  const { keepAppPicture, readAppPicture, keepAppFile, readAppFile, appFileUrl } = await import("../../worker/gatewayChat.js");
  const kept = { ids: [], files: [], attachments: [] };
  for (const [index, data] of pictures.entries()) {
    const bytes = bytesOf(data);
    const id = bytes === null ? null : await keepAppPicture(storage, bytes, now);
    if (id === null) {
      await forgetKept(storage, kept);
      return null;
    }
    const picture = await readAppPicture(storage, id);
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" }[picture?.mediaType] ?? "jpg";
    kept.ids.push(id);
    kept.attachments.push({ url: `https://app-chat.invalid/pic/${id}.${extension}`, mimeType: picture?.mediaType ?? "image/jpeg", filename: `picture-${index + 1}.${extension}`, size: bytes.byteLength });
  }
  for (const file of files) {
    const bytes = typeof file?.name === "string" && typeof file.data === "string" ? bytesOf(file.data) : null;
    const id = bytes === null ? null : await keepAppFile(storage, bytes, file.name, now);
    if (id === null) {
      await forgetKept(storage, kept);
      return null;
    }
    // Recorded at once, so a file that cannot be read back is taken back with the rest.
    const record = await readAppFile(storage, id);
    kept.files.push({ id, name: record?.name ?? "file", type: record?.mediaType ?? "", size: record?.bytes.byteLength ?? 0 });
    if (record === null) {
      await forgetKept(storage, kept);
      return null;
    }
    // The name and the kind are the ones kept, cleaned by the store, so the address, the attachment and the row agree.
    kept.attachments.push({ url: appFileUrl(id, record.name), mimeType: record.mediaType, filename: record.name, size: record.bytes.byteLength });
  }
  return kept;
}

/** Takes back everything a send kept: its pictures and its files, every piece. */
async function forgetKept(storage, kept) {
  const { forgetAppPicture, forgetAppFile } = await import("../../worker/gatewayChat.js");
  for (const id of kept.ids) await forgetAppPicture(storage, id);
  for (const file of kept.files) await forgetAppFile(storage, file.id);
}

/**
 * `POST /app/arrive`: `{ kind: "one" | "react" | "edit", inbox, message, pictures?, tap? }`, the body the gateway route
 * builds (the shapes Photon's line hands the chat object: `inboundOf` in `labSandbox/chatRun.js`). Every call counts
 * against the day's cap first and is given back if the chat object does not take it.
 *
 *  - `one`: a text, with up to `MAX_APP_PICTURES` pictures and files together (base64; a file is `{ name, data }`), kept
 *    here and handed over as attachments. Answers the event id the object logged it under, and keeps the pictures' ids
 *    and the files' `{ id, name, type, size }` beside that event for the app to show.
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
  const files = body.kind === "one" && Array.isArray(body.files) ? body.files : [];
  // Pictures and files share one limit per text, and one day's cap (`takeSend`).
  const count = pictures.length + files.length;
  if (count > MAX_APP_PICTURES) return Response.json({ error: "bad_body" }, { status: 400 });
  if (!(await takeSend(state, now(), count))) {
    console.log(JSON.stringify({ event: "app_chat_arrive", kind: body.kind, outcome: "limit" }));
    return Response.json({ outcome: "limit" }, { status: 429 });
  }
  let message = body.message;
  let kept = null;
  if (count > 0) {
    kept = await keptAttachments(state.storage, pictures, files, now());
    if (kept === null) {
      await giveBackSend(state, now(), count);
      return Response.json({ error: "bad_picture" }, { status: 400 });
    }
    message = { ...message, attachments: kept.attachments };
  }
  const chat = await open(body.inbox);
  const answer = chat === null ? null : await chat.fetch(new Request(`https://inbox${path}`, { method: "POST", body: JSON.stringify(message) }));
  const ok = answer !== null && answer.ok;
  if (!ok) {
    await giveBackSend(state, now(), count);
    // The chat object did not take the text: what was kept for it is taken back too.
    if (kept !== null) await forgetKept(state.storage, kept);
  }
  const outcome = ok ? await answer.json().catch(() => ({})) : {};
  const result = ok ? (typeof outcome.outcome === "string" ? outcome.outcome : "queued") : chat === null ? "not_here" : "failed";
  let ev = null;
  if (ok && body.kind === "one") {
    ev = await eventOfHandle(state.storage, message.messageId);
    // Kept beside the event: its pictures and files, and the row it replies to (a picture has no words to find it by).
    const replyOn = typeof body.replyOn === "string" && body.replyOn.length <= 64 ? body.replyOn : null;
    const pics = kept?.ids ?? [];
    const fileMeta = kept?.files ?? [];
    if (ev !== null && (pics.length > 0 || fileMeta.length > 0 || replyOn !== null)) {
      await state.storage.put(`${META_PREFIX}${ev}`, {
        ...(pics.length > 0 ? { pics } : {}),
        ...(fileMeta.length > 0 ? { files: fileMeta } : {}),
        ...(replyOn !== null ? { replyTo: replyOn } : {}),
      });
    }
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
  // An unsent text's pictures and files are deleted, not only hidden (`forget`, `forgetFiles`: the ids the route found on that text).
  if (ok && body.kind === "edit" && body.message.kind === "unsent") {
    const { forgetAppPicture, forgetAppFile } = await import("../../worker/gatewayChat.js");
    for (const id of Array.isArray(body.forget) ? body.forget : []) if (typeof id === "string") await forgetAppPicture(state.storage, id);
    for (const id of Array.isArray(body.forgetFiles) ? body.forgetFiles : []) if (typeof id === "string") await forgetAppFile(state.storage, id);
  }
  console.log(JSON.stringify({ event: "app_chat_arrive", kind: body.kind, outcome: result, attachments: count }));
  return Response.json({ outcome: result, ...(ev !== null ? { ev } : {}) }, { status: ok ? 200 : 503 });
}

/** `GET /app/file/<id>`: one of this chat's kept files (its bytes and kind), or 404. The route names it to the person. */
export async function serveAppFileById(storage, id) {
  if (!(await isAppChatName(await storage.get(NAME_KEY)))) return new Response(null, { status: 404 });
  const { readAppFile } = await import("../../worker/gatewayChat.js");
  const kept = await readAppFile(storage, id);
  if (kept === null) return new Response(null, { status: 404 });
  return new Response(kept.bytes, { headers: { "content-type": kept.mediaType } });
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
export async function serveAppOutbox(storage) {
  const name = await storage.get(NAME_KEY);
  if (typeof name !== "string") return Response.json({ events: [], typingAt: null, metas: {}, taps: {}, handles: {} });
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
  return Response.json({ events, typingAt: typeof typingAt === "number" ? typingAt : null, metas: await byEvent(META_PREFIX), taps: await byEvent(TAP_PREFIX), handles });
}
