/**
 * `POST /files/write`: the app saving a whole note, written by the gateway into the note's workspace object as an AI
 * client's save is, with no control plane on the way (`docs/decisions/storage-and-credentials/app-saves-through-gateway.md`,
 * decided by the owner, 2026-11-24).
 *
 * Until then every whole-note save the app made (a new note, the offline outbox's drain, a folder list, a task) went
 * through the control plane's `files.writeNote`, so a note's text passed through Convex on its way to the object.
 *
 * It keeps that action's rules exactly, because the offline outbox depends on them (`queuedWrite.ts` in the app):
 *
 *  - over a note edited live, the save is the editor's whole-text replacement, merged from the exact version it was
 *    typed against (`replaceLiveText`, as `/collaboration` does), so an edit typed offline is merged, not refused;
 *  - no `expectedEtag` is a create, and a conflict if anything is there now; a version for a note that is gone is a
 *    conflict with no current version; a conflict names the note's current version, as `files.writeNote` does;
 *  - a new note takes its folder's access, and a team reader creates only in a folder open to them.
 *
 * What this route does not settle answers 409 `not_object`, and the app makes the control plane's call as before: a
 * person without the flag, a workspace whose notes are not in its object, a note the reader may not see (the same
 * answer whether or not it exists), an encrypted note or an envelope, a note that is not collaborative Markdown, a
 * form, Tex's folder, a group's folder, a name twinned by case. Each logs a reason, never a path.
 *
 * First-party only, as `/approvals` is: the console's own client (`context_console`). An AI client saves with
 * `write_note`, whose gates are for a model's call. The body names the workspace, and a session for any other is
 * refused, so a queue filed under one workspace can never be written into another.
 */

import { announceCommittedToPresence, announceWriteToPresence, presenceActor } from "./presence.js";
import { replaceLiveText } from "./collaborationInObject.js";
import { MAX_COLLABORATION_NOTE_BYTES } from "./collaborationHttp.js";
import { eligible as collaborationEligible, supported as collaborationSupported } from "@context/collaboration";
import { canSee, effectiveVisibility, isPlumbing, isTexKey, PRIVACY_KEY, visibilityOf } from "../privacy/engine.js";
import { isEncryptedNote } from "../encryption/format.js";
import { flagOn } from "../flags.js";
import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { byteSize } from "../notes/format.js";
import { normalizePath } from "../notes/paths.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { loadPrivacyState } from "../privacy/state.js";
import { parseFormBlocks } from "../forms.js";
import { nameTwinRefusal } from "../tree/twins.js";
import { inChatHome } from "../../../../packages/tex/gateway/agent/chatHomeSeal.js";
import { projectWrittenNoteAfterResponse } from "../search/writeProjection.js";
import { frontMatterChanged } from "../activity/changes.js";
import { recordChange } from "../activity/record.js";
import { stampAfterQuiet } from "../notes/dateStamp.js";

export const NOTE_WRITE_PATH = "/files/write";

/** The flag that turns this route on for a person (`packages/shared/src/flags.cjs`). */
export const APP_SAVES_FLAG = "files.app-saves-in-objects";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";

const MAX_PATH = 1024;
const MAX_ETAG = 512;
/** The note itself, its JSON quoting, and the two short fields beside it. */
const MAX_BODY_BYTES = MAX_COLLABORATION_NOTE_BYTES * 2 + 8 * 1024;

/** The control plane's own words for each conflict (`apps/convex/functions/lib/fileOps/writing.ts`), so the app's
 * outbox and editor say what they said before. */
export const CONFLICT_MESSAGES = Object.freeze({
  exists: "A file already exists at that path. Reload to see it.",
  gone: "That file was deleted somewhere else while you were editing it.",
  changed: "That file changed somewhere else while you were editing it.",
});
const UNSAFE_MESSAGE = "This note cannot be saved safely for collaborative editing.";

/** The engine's refusals that mean "the note moved on" (`fileOps/writing.ts` lists the same). */
const CONFLICT_CODES = new Set(["BASE_MISSING", "CONFLICT", "GENERATION_MISMATCH", "SEAL_CONFLICT", "CONCURRENT_WRITE"]);
const UNSAFE_CODES = new Set(["UNSUPPORTED_STORAGE", "STORAGE_WRITE_FAILED", "CORRUPT_STATE"]);

const conflict = (reason, currentEtag) =>
  json({ error: "conflict", code: "CONFLICT", message: CONFLICT_MESSAGES[reason], ...(typeof currentEtag === "string" ? { currentEtag } : {}) }, 409);

/** Handed back to the control plane; the reason is logged and never sent, so the answer is the same for every one. */
function notServed(store, reason) {
  console.log(JSON.stringify({ event: "app_save_not_served", reason, workspaceId: store?.actor?.workspaceId ?? null }));
  return json({ error: "not_object" }, 409);
}

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

/** The body, checked field by field; unknown keys are refused, so nothing rides along. */
function parse(body) {
  if (Object.keys(body).some((key) => !["workspaceId", "path", "text", "expectedEtag"].includes(key))) return null;
  const { workspaceId, path, text, expectedEtag } = body;
  if (typeof workspaceId !== "string" || workspaceId === "" || workspaceId.length > 128) return null;
  if (typeof path !== "string" || path.length > MAX_PATH || path.includes("\0")) return null;
  if (typeof text !== "string") return null;
  if (expectedEtag !== undefined && (typeof expectedEtag !== "string" || expectedEtag === "" || expectedEtag.length > MAX_ETAG)) return null;
  const normalized = normalizePath(path);
  if (!normalized) return null;
  return { workspaceId, path: normalized, text, ...(expectedEtag === undefined ? {} : { expectedEtag }) };
}

/** What `files.writeNote` answers (`writtenValidator`), so nothing past the app's call changes. */
const written = (path, etag, text) =>
  json({ kind: "written", path, etag, bytes: byteSize(text), conflictCheck: "conditional", forms: { created: [], occupied: [] } });

/**
 * Serves one save for `session` on `store`, the request's own store (`objectReading` names the workspace's object
 * and its home). `route.js` has already checked the write scope; it is checked again here, so this function is safe
 * on its own.
 */
export async function handleNoteWrite(request, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (session?.actorClientId !== CONSOLE_CLIENT_ID) {
    return json({ error: "forbidden", error_description: "Only the Context app saves here; an AI client saves with write_note." }, 403);
  }
  if (!hasScope(session, SCOPE_WRITE)) return json({ error: "forbidden" }, 403);
  const body = await readBody(request);
  if (body === null) return json({ error: "invalid_request" }, 400);
  const asked = parse(body);
  if (asked === null) return json({ error: "invalid_request" }, 400);
  // The workspace the app filed this save under, and the one this session acts in, must be the same one. Checked
  // before anything else is read, so a save sent to the wrong address learns nothing and writes nothing.
  if (asked.workspaceId !== session.workspaceId) return json({ error: "wrong_workspace" }, 409);

  const { path, text, expectedEtag } = asked;
  if (isPlumbing(path)) return json({ error: "invalid_path" }, 400);
  if (!flagOn(session, APP_SAVES_FLAG)) return notServed(store, "flag_off");
  const reading = store?.objectReading ?? null;
  if (reading === null || reading.client === null || reading.home !== "object" || reading.behind === true) return notServed(store, "not_object");
  // Markdown only: pictures, sheets and the old access file stay with the control plane's save.
  if (!path.endsWith(".md") || path.toLowerCase() === PRIVACY_KEY) return notServed(store, "not_markdown");
  // Tex's notes live in Tex's store, and a chat's home is sealed: both are the control plane's to route for now.
  if (/^tex\//i.test(path) || inChatHome(store, path)) return notServed(store, "tex");
  if (isEncryptedNote(text)) return notServed(store, "envelope");
  if (byteSize(text) > MAX_COLLABORATION_NOTE_BYTES) return notServed(store, "too_large");
  // A form's response file is seeded by the control plane's save (`fileOps` `ensureFormResponseFiles`).
  if (parseFormBlocks(text).length > 0) return notServed(store, "form");

  const privacy = await loadPrivacyState(store);
  if (privacy.error) return json({ error: "unavailable" }, 503);
  const { rules, overrides } = privacy;
  // Judged on the path alone, before anything about the note is looked up: held back and missing answer alike.
  if (!canSee(path, session.scope, rules, overrides, session.grantedGroups)) return notServed(store, "hidden");

  const stored = await getWithLegacyFallback(store, path);
  if (stored === null) return await create(store, session, rules, overrides, { path, text, expectedEtag });
  if (isTexKey(stored.key)) return notServed(store, "tex");
  const storedText = await stored.text();
  if (isEncryptedNote(storedText)) return notServed(store, "encrypted");
  if (!collaborationSupported(store) || !collaborationEligible(path, storedText) || byteSize(storedText) > MAX_COLLABORATION_NOTE_BYTES) {
    return notServed(store, "not_collaborative");
  }
  if (expectedEtag === undefined) return conflict("exists", stored.etag);

  let result;
  try {
    // Merged from the version the app read, inside the note's object (`collaborationInObject.js`).
    result = await replaceLiveText(store, path, { expectedEtag, text });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (CONFLICT_CODES.has(code)) return conflict("changed", stored.etag);
    if (UNSAFE_CODES.has(code)) return json({ error: "unsafe", code: "STORAGE_UNSAFE", message: UNSAFE_MESSAGE }, 503);
    // Anything else (a note moved on the way, a malformed answer) is the control plane's to answer, as it did before.
    if (code !== "") return notServed(store, "engine_refused");
    return json({ error: "unavailable" }, 503);
  }
  if (typeof result?.text !== "string" || typeof result?.etag !== "string") return json({ error: "unavailable" }, 503);
  if (result.text !== storedText) {
    const visibility = effectiveVisibility(path, rules, overrides);
    await recordChange(store, "update_note", session.scope, [path], {
      etag: result.etag,
      visibility,
      team_visible: visibility === "team",
      content_bytes: byteSize(result.text),
      previous_bytes: byteSize(storedText),
      ...(frontMatterChanged(storedText, result.text) ? { front_matter_changed: true } : {}),
    });
    await projectWrittenNoteAfterResponse(store, { path, content: result.text, version: result.etag, visibility });
  }
  await announceCommittedToPresence(store, path, result);
  if (result.text !== storedText) stampAfterQuiet(store, path, result, storedText, Date.now());
  return written(path, result.etag, result.text);
}

/** A new note: its folder's access, a conditional create, and the change recorded as a save from the app. */
async function create(store, session, rules, overrides, { path, text, expectedEtag }) {
  if (expectedEtag !== undefined) return conflict("gone");
  const inherited = visibilityOf(path, rules);
  // A folder held back to a group, or a team reader creating where the folder is not open to them: the control
  // plane's save answers, as it always has, with the same refusal as a hidden note.
  if (inherited !== "private" && inherited !== "team") return notServed(store, "group_folder");
  if (session.scope !== "private" && inherited !== "team") return notServed(store, "hidden");
  // `projects/x.md` beside `Projects/`: the control plane names the twin (`fileOps/nameTwins.ts`).
  if (await nameTwinRefusal(store, session.scope, rules, overrides, path).catch(() => "unknown")) return notServed(store, "name_twin");

  let put;
  try {
    // No access is pinned on it: it takes its folder's, as the control plane's save left it (`tier` lets the object
    // adopt the row; `store/objectLookup.js`).
    put = await store.put(path, text, { onlyIf: { absent: true }, tier: inherited });
  } catch (error) {
    if (error?.name === "NoteCreateRaced") return conflict("exists", typeof error.currentEtag === "string" ? error.currentEtag : undefined);
    // The free plan's cap refuses before anything is put: the control plane's save says so in its own words.
    if (error?.name === "NoteCapReached") return notServed(store, "note_cap");
    throw error;
  }
  if (!put) {
    const there = await getWithLegacyFallback(store, path).catch(() => null);
    return conflict("exists", there?.etag);
  }
  const visibility = effectiveVisibility(path, rules, overrides);
  await recordChange(store, "create_note", session.scope, [path], {
    etag: put.etag,
    visibility,
    team_visible: visibility === "team",
    content_bytes: byteSize(text),
  });
  await projectWrittenNoteAfterResponse(store, { path, content: text, version: put.etag, visibility });
  await announceWriteToPresence(store, { path, content: text, etag: put.etag, actor: await presenceActor(store.actor) });
  return written(path, put.etag, text);
}
