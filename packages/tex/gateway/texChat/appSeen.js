/**
 * The screen the Context app had open when the person texted (`agent/screen.js`), kept beside the app chat's object under
 * `app:seen`: one value, replaced by each send that carries one. It is not a ledger event, a row or a word of the chat, so
 * the page never shows it and nothing else reads it but the turn (`screen.js` `readScreen`).
 *
 * Only an app chat keeps one (`POST` answers 404 for any other chat's name); `GET` answers what is kept, or `{}`.
 */

import { NAME_KEY, isAppChatName } from "./appChat.js";

/** The storage key the app's screen is kept under on the app chat's object. */
export const SEEN_KEY = "app:seen";

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `POST /app/seen`: `{ inbox, note?, tabs?, selection?, at }`, the route's body (`agent/appChatRoute.js` `saveSeen`). Only the
 * parts it names are kept, and `at` is required: the turn reads the screen only while it is recent.
 */
export async function serveAppSeenPost(request, { storage }) {
  const body = await request.json().catch(() => null);
  if (!isPlainObject(body) || !(await isAppChatName(body.inbox))) return new Response(null, { status: 404 });
  // A placed object answers to the name it was placed under, never another (as `serveAppArrive` does).
  const own = await storage.get(NAME_KEY);
  if (own !== undefined && own !== body.inbox) return new Response(null, { status: 404 });
  if (typeof body.at !== "number" || !Number.isFinite(body.at)) return Response.json({ error: "bad_body" }, { status: 400 });
  const kept = {
    ...(isPlainObject(body.note) ? { note: body.note } : {}),
    ...(Array.isArray(body.tabs) ? { tabs: body.tabs } : {}),
    ...(typeof body.selection === "string" ? { selection: body.selection } : {}),
    at: body.at,
  };
  await storage.put(SEEN_KEY, kept);
  return Response.json({ ok: true });
}

/** `GET /app/seen`: what the app kept, or `{}`; 404 when this object belongs to a chat that is not the app's. */
export async function serveAppSeenGet(storage) {
  const name = await storage.get(NAME_KEY);
  if (typeof name === "string" && !(await isAppChatName(name))) return new Response(null, { status: 404 });
  return Response.json((await storage.get(SEEN_KEY)) ?? {});
}
