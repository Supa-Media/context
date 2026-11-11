/**
 * `POST /files/read`: the app opening a note to edit it, read inside the note's workspace object in one call
 * (`workspaceStore/collabRead.js`), with no control plane on the way.
 *
 * Until 2026-11-11 the app opened every note through the control plane's `files.readNote`, which ran its own copy of
 * the editing-history engine against the workspace object, one storage call at a time over the network, while the
 * gateway saved the person's typing into the same history with another copy. When the two met, the control plane's
 * read gave up ("This note cannot be opened safely for collaborative editing right now") and the app closed the note
 * the person was typing in (Dev2, 2026-11-11). Read here, the engine runs once, inside the object, which takes one
 * call at a time, so a read and a save cannot interleave.
 *
 * The answer is the shape `files.readNote` answers (`OpenNote` in the app). What this route does not serve answers
 * 409 `not_object`, and the app asks the control plane as before: a workspace whose notes are not in its object yet,
 * a file that is not a Markdown note, a Tex note (in Tex's store), and a name with no note this reader may open.
 * That last one is the same answer whether the note is missing or held back, and the control plane then judges it
 * as it always has, following a renamed note's old address to where it went.
 *
 * Who may read is judged here by the session's own scope and names, as `/collaboration` judges them, and the object is
 * asked only once the reader has passed: a private note's words never leave the object for somebody who may not read
 * them. A password-encrypted note is answered as its ciphertext, read-only, as the control plane answers it.
 */

import { canSee, effectiveVisibility, isPlumbing, PRIVACY_KEY, visibilityOf } from "../privacy/engine.js";
import { isEncryptedNote } from "../encryption/format.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_READ } from "../session.js";
import { normalizePath } from "../notes/paths.js";
import { loadPrivacyState } from "../privacy/state.js";

export const NOTE_READ_PATH = "/files/read";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_PATH = 1024;

const notServed = () => json({ error: "not_object" }, 409);

async function readBody(request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * Serves one open for `session` on `store`, the request's own store (`objectReading` names the workspace's object
 * and its home; the id layer's `oneRead` view looks the name up once).
 */
export async function handleNoteRead(request, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!hasScope(session, SCOPE_READ)) return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  if (body === null || Object.keys(body).some((key) => key !== "path")) return json({ error: "invalid_request" }, 400);
  const path = typeof body.path === "string" && body.path.length <= MAX_PATH && !body.path.includes("\0") ? normalizePath(body.path) : null;
  if (!path || isPlumbing(path)) return json({ error: "invalid_path" }, 400);
  // Pictures, PDFs and the rest, and the old access file, stay with the control plane's read.
  if (!path.endsWith(".md") || path.toLowerCase() === PRIVACY_KEY) return notServed();

  const reading = store?.objectReading ?? null;
  if (reading === null || reading.client === null || reading.home !== "object" || reading.behind === true) return notServed();
  const view = typeof store.oneRead === "function" ? store.oneRead(store) : store;
  if (typeof view.readInObject !== "function" || typeof view.noteAt !== "function") return notServed();

  const privacy = await loadPrivacyState(store);
  if (privacy.error) return json({ error: "unavailable" }, 503);
  const { rules, overrides } = privacy;
  const seen = canSee(path, session.scope, rules, overrides, session.grantedGroups);
  // The name is looked up for every reader, so a held-back note costs what a missing one costs.
  const row = await view.noteAt(path).catch(() => null);
  if (!seen || row === null) return notServed();

  let answer;
  try {
    answer = await view.readInObject(path, { start: true });
  } catch {
    return json({ error: "unavailable" }, 503);
  }
  // Not this object's to answer (a Tex note, a row that moved on the way): the control plane reads it, as before.
  if (answer === null || answer === undefined) return notServed();
  // The engine could not give the history's text just now (a save still waiting on an earlier one, say). Not a
  // refusal: the reader may read this note, and the app keeps what it shows and asks again.
  if (answer.error) return json({ error: "unavailable" }, 503);

  const markdown = answer.markdown;
  const collaboration = answer.collaboration ?? null;
  const encrypted = isEncryptedNote(markdown.text);
  const visibility = effectiveVisibility(path, rules, overrides);
  const inherited = visibilityOf(path, rules);
  return json({
    kind: "file",
    path,
    text: collaboration?.text ?? markdown.text,
    etag: collaboration?.etag ?? markdown.etag,
    ...(collaboration ? { rawEtag: markdown.etag, documentId: collaboration.documentId } : {}),
    visibility,
    inherited,
    exception: visibility !== inherited,
    readOnly: encrypted,
    encrypted,
  });
}
