/** `POST /granola-webhook` — signed Granola note events (single-deployment only). */

import { deleteWithLegacyFallback, getWithLegacyFallback } from "../storageLayout.js";
import {
  GRANOLA_COMPLETED_PREFIX,
  GRANOLA_PENDING_PREFIX,
  GRANOLA_WEBHOOK_BYTE_CAP,
  verifyGranolaSignature,
} from "./granola.js";
import { json } from "../http/responses.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { safeSlug, singleLine } from "./inbox.js";
import { writeInboxCapture } from "./inboxRoute.js";

/* --------------------------- Granola webhooks ---------------------------- */

export async function handleGranolaWebhook(request, env, store, ctx) {
  if (!env.GRANOLA_WEBHOOK_SECRET) return json({ error: "not_configured" }, 503);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > GRANOLA_WEBHOOK_BYTE_CAP) return json({ error: "too_large" }, 413);
  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > GRANOLA_WEBHOOK_BYTE_CAP) return json({ error: "too_large" }, 413);
  const raw = new TextDecoder().decode(rawBytes);

  const signatureOk = await verifyGranolaSignature(request.headers, raw, env.GRANOLA_WEBHOOK_SECRET);
  if (!signatureOk) return json({ error: "invalid_signature" }, 401);

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const eventId = singleLine(event?.event_id || "");
  const eventType = singleLine(event?.event_type || "");
  const noteId = singleLine(event?.note_id || "");
  if (
    !eventId ||
    !/^not_[a-zA-Z0-9]{14}$/.test(noteId) ||
    !["note.generated", "note.edited", "note.access_granted"].includes(eventType)
  ) {
    return json({ error: "invalid_event" }, 400);
  }

  const completedKey = `${GRANOLA_COMPLETED_PREFIX}${safeSlug(eventId, 80)}.json`;
  if (await getWithLegacyFallback(store, completedKey)) return json({ ok: true, duplicate: true });

  const pendingKey = `${GRANOLA_PENDING_PREFIX}${safeSlug(eventId, 80)}.json`;
  await store.put(pendingKey, JSON.stringify({ ...event, received_at: new Date().toISOString() }));
  const work = processGranolaEventSafely(env, store, pendingKey);
  if (ctx?.waitUntil) ctx.waitUntil(work);
  else await work;
  return json({ ok: true, accepted: true }, 202);
}

async function processGranolaEventSafely(env, store, pendingKey) {
  try {
    await processGranolaEvent(env, store, pendingKey);
  } catch (error) {
    const pending = await getWithLegacyFallback(store, pendingKey);
    if (!pending) return;
    let event = {};
    try {
      event = JSON.parse(await pending.text());
    } catch {}
    await store.put(
      pendingKey,
      JSON.stringify({
        ...event,
        attempts: Number(event.attempts || 0) + 1,
        last_attempt_at: new Date().toISOString(),
        last_error: singleLine(error?.message || "Granola sync failed").slice(0, 300),
      })
    );
  }
}

async function processGranolaEvent(env, store, pendingKey) {
  if (!env.GRANOLA_API_KEY) throw new Error("GRANOLA_API_KEY is not configured");
  const pending = await getWithLegacyFallback(store, pendingKey);
  if (!pending) return;
  const event = JSON.parse(await pending.text());
  const response = await fetch(`https://public-api.granola.ai/v1/notes/${encodeURIComponent(event.note_id)}`, {
    headers: { Authorization: `Bearer ${env.GRANOLA_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Granola Get Note returned ${response.status}`);
  const note = await response.json();
  const text = note.summary_markdown || note.summary_text || "";
  if (!String(text).trim()) throw new Error("Granola note has no generated summary yet");

  await writeInboxCapture(
    store,
    {
      title: note.title || "Granola meeting",
      text,
      source: "granola",
      externalId: note.id || event.note_id,
      sourceUrl: note.web_url || "",
      sourceCreatedAt: note.created_at || event.occurred_at || "",
      attendees: note.attendees || [],
      metadata: {
        event_type: event.event_type,
        event_id: event.event_id,
        updated_at: note.updated_at || null,
        owner: note.owner || null,
        calendar_event: note.calendar_event || null,
        folders: note.folder_membership || [],
      },
    },
    { actorScope: "granola", replaceExisting: true }
  );

  const eventSlug = safeSlug(event.event_id, 80);
  await store.put(
    `${GRANOLA_COMPLETED_PREFIX}${eventSlug}.json`,
    JSON.stringify({ event_id: event.event_id, note_id: event.note_id, completed_at: new Date().toISOString() })
  );
  await deleteWithLegacyFallback(store, pendingKey);
}

export async function processPendingGranolaEvents(env, store) {
  if (!env.GRANOLA_API_KEY) return;
  const pending = (await listAllKeysWithLegacy(store, GRANOLA_PENDING_PREFIX)).slice(0, 100);
  await Promise.all(pending.map(({ key }) => processGranolaEventSafely(env, store, key)));
}
