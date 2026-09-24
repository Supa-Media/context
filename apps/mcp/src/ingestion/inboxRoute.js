/** `POST /inbox` — a capture dropped into `0-inbox/`. */

import { actorFor } from "../context/identity.js";
import {
  generatedCollaborationBase,
  generatedNoteFor,
  openStoredNote,
  writeGeneratedNote,
} from "../notes/sealing.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { hasScope, SCOPE_READ } from "../session.js";
import {
  INBOX_CONTENT_BYTE_CAP,
  normalizeInboxAttendees,
  safeSlug,
  sha256Hex,
  singleLine,
} from "./inbox.js";
import { json } from "../http/responses.js";
import { recordChange } from "../activity/record.js";

/* -------------------------------- inbox ---------------------------------- */

export async function handleInbox(request, env, store, session) {
  // The grant's own context, and no other. This path takes no `context`
  // argument, and the store it is handed was built without an opener at all —
  // so the credential that sits unattended on a laptop reaches exactly one
  // context, which is the whole of what makes a capture-only grant cheap.
  store.actor = actorFor(session);

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > INBOX_CONTENT_BYTE_CAP) {
    return json({ error: "too_large", max_bytes: INBOX_CONTENT_BYTE_CAP }, 413);
  }

  const rawBytes = await request.arrayBuffer();
  if (rawBytes.byteLength > INBOX_CONTENT_BYTE_CAP) {
    return json({ error: "too_large", max_bytes: INBOX_CONTENT_BYTE_CAP }, 413);
  }
  const raw = new TextDecoder().decode(rawBytes);

  let capture = { title: "capture", text: "", source: "inbox" };
  const ct = request.headers.get("Content-Type") || "";
  if (ct.includes("application/json")) {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_json" }, 400);
    }
    capture = {
      title: body.title || "capture",
      text: body.text ?? body.content ?? body.notes ?? "",
      source: body.source || "inbox",
      externalId: body.external_id ?? body.id ?? "",
      sourceUrl: body.source_url ?? body.url ?? "",
      sourceCreatedAt: body.source_created_at ?? body.created_at ?? "",
      attendees: body.attendees,
      metadata: body.metadata ?? null,
    };
  } else {
    capture.text = raw;
  }
  if (!String(capture.text).trim()) return json({ error: "empty" }, 400);

  // A capture-only grant records as "inbox"; a full connection that happens to
  // POST a capture records as itself, so the audit trail distinguishes an
  // automation drop from a person filing something by hand.
  const actorScope = hasScope(session, SCOPE_READ) ? session.scope : "inbox";
  const result = await writeInboxCapture(store, capture, { actorScope });
  return json({ ok: true, ...result });
}

export async function writeInboxCapture(store, capture, { actorScope = "inbox", replaceExisting = false } = {}) {
  const now = new Date();
  const title = singleLine(capture.title || "capture");
  const text = String(capture.text ?? "");
  const source = singleLine(capture.source || "inbox");
  const externalId = singleLine(capture.externalId || "");
  const sourceUrl = singleLine(capture.sourceUrl || "");
  const sourceCreatedAt = singleLine(capture.sourceCreatedAt || "");
  const attendees = normalizeInboxAttendees(capture.attendees);
  const metadata = capture.metadata ?? null;
  const sourceSlug = safeSlug(source, 30);
  let key;
  if (externalId) {
    const fingerprint = await sha256Hex(`${source}\0${externalId}`);
    key = `0-inbox/${sourceSlug}/${fingerprint.slice(0, 24)}.md`;
  } else {
    const titleSlug = safeSlug(title, 40);
    key = `0-inbox/${now.toISOString().slice(0, 19).replace(/[:]/g, "-")}-${titleSlug}.md`;
  }

  const existing = await getWithLegacyFallback(store, key);
  if (existing && !replaceExisting) return { path: key, duplicate: true };

  const frontmatter = [
    "---",
    `captured: ${JSON.stringify(now.toISOString())}`,
    `source: ${JSON.stringify(source)}`,
    "status: unprocessed",
  ];
  if (externalId) frontmatter.push(`external-id: ${JSON.stringify(externalId)}`);
  if (sourceCreatedAt) frontmatter.push(`source-created-at: ${JSON.stringify(sourceCreatedAt)}`);
  if (sourceUrl) frontmatter.push(`source-url: ${JSON.stringify(sourceUrl)}`);
  frontmatter.push("---");

  const bodyParts = [`# ${title}`, ""];
  if (sourceUrl) bodyParts.push(`Source: <${sourceUrl}>`, "");
  if (attendees.length) {
    bodyParts.push("## Attendees", "", ...attendees.map((attendee) => `- ${attendee}`), "");
  }
  bodyParts.push(text.trim(), "");
  if (metadata !== null && metadata !== "") {
    const metadataText =
      typeof metadata === "string" ? metadata : JSON.stringify(metadata, null, 2);
    bodyParts.push("## Capture metadata", "", "```json", metadataText, "```", "");
  }

  const note = `${frontmatter.join("\n")}\n\n${bodyParts.join("\n")}`;
  let previous = null;
  let collaborationBase = null;
  if (existing) {
    previous = await existing.text();
    collaborationBase = await generatedCollaborationBase(store, key, previous);
    previous = collaborationBase?.text ?? previous;
    // Idempotency only. An unchanged capture is not re-written; a changed one
    // overwrites, and the version it replaces is kept only if the customer
    // enabled versioning on their bucket.
    //
    // Compared against the *plaintext* where the note is encrypted, or every
    // replay of the same capture would look changed — the envelope is never
    // equal to the note it holds — and would burn a write and a sync in every
    // connected vault for a capture nobody made.
    const opened = await openStoredNote(store, previous);
    if (opened.ok && opened.text === note) return { path: key, duplicate: true };
  }
  // The form of the note at this path outlives this capture. See
  // `generatedNoteBytes`.
  const body = await generatedNoteFor(store, note, previous);
  if (body === null) return { path: key, duplicate: false, updated: false, locked: true };
  await writeGeneratedNote(store, key, body, collaborationBase);
  await recordChange(store, existing ? "inbox_update" : "inbox_capture", actorScope, [key], { source });
  return { path: key, duplicate: false, updated: Boolean(existing) };
}
