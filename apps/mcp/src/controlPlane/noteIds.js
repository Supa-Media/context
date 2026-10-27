/**
 * Where each note's bytes live, read and recorded by the control plane
 * (`store/idLayout.js`, and
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Both calls spend the same two proofs `/gateway/tree/facts` does: the gateway
 * secret in the header, and the person's own access token in the body. The
 * control plane derives the workspace from that token's grant; the
 * `workspaceId` and `expectedWorkspaceId` fields only let it refuse a mismatch.
 */
import { ControlPlaneError } from "./client.js";
import { isIdKey } from "../privacy/engine.js";
import { isNoteId } from "../store/noteIdKeys.js";

function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * One `notes` entry as the id layer may act on it, or `null`. A keyed entry
 * needs a real id key and a version; anything malformed is dropped (the lookup
 * then names no note there, so a read finds nothing). A row the control plane
 * says is still at its path is carried as `{state: "path"}` only so the layer
 * can refuse it.
 */
export function narrowNote(entry) {
  if (!entry || typeof entry !== "object") return null;
  switch (entry.state) {
    case "keyed": {
      const etag = text(entry.etag);
      if (!isIdKey(entry.key) || etag === null) return null;
      return {
        state: "keyed",
        key: entry.key,
        etag,
        ...(isNoteId(entry.noteId) ? { noteId: entry.noteId } : {}),
        ...(Number.isFinite(entry.size) ? { size: entry.size } : {}),
        ...(text(entry.legacyEtag) === null ? {} : { legacyEtag: entry.legacyEtag }),
      };
    }
    case "path":
      return { state: "path" };
    case "gone":
      return { state: "gone" };
    case "folder":
      return { state: "folder" };
    default:
      return null;
  }
}

/** The most paths one lookup may ask about: the control plane's `NOTE_ID_LOOKUP_MAX`. */
export const NOTE_ID_LOOKUP_MAX = 200;

/** The most note ids one resolve may name: the control plane's `NOTE_IDS_RESOLVE_IDS`. */
export const NOTE_ID_RESOLVE_MAX = 200;

export function createNoteIdMethods({ post, required }) {
  return {
    /**
     * What the tree says about each path (`/gateway/note-ids/lookup`): `keyed`
     * for the workspace, and `notes`, one entry per path with a row. Paths with
     * no row are absent.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {string[]} paths
     * @returns {Promise<{keyed: boolean, notes: Record<string, object>}>}
     */
    async noteIdLookup(accessToken, workspaceId, paths) {
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > NOTE_ID_LOOKUP_MAX) {
        throw new ControlPlaneError("note id lookup needs 1 to 200 paths");
      }
      const parsed = await post("/gateway/note-ids/lookup", {
        workspaceId,
        paths,
        accessToken,
        expectedWorkspaceId: workspaceId,
      });
      if (!parsed.notes || typeof parsed.notes !== "object" || Array.isArray(parsed.notes)) {
        throw new ControlPlaneError("malformed note id entries");
      }
      const notes = {};
      for (const path of Object.keys(parsed.notes)) {
        const entry = narrowNote(parsed.notes[path]);
        if (entry !== null) notes[path] = entry;
      }
      return { keyed: parsed.keyed === true, notes };
    },

    /**
     * The current path of each note id, for the caller's workspace only
     * (`/gateway/note-ids/resolve`). `paths` has every id asked for: its path
     * where a live row the caller may see holds it, and `null` otherwise
     * (trashed, moved under a dot folder, another workspace's, or not seen).
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {string[]} noteIds
     * @returns {Promise<{paths: Record<string, string|null>}>}
     */
    async noteIdResolve(accessToken, workspaceId, noteIds) {
      if (!Array.isArray(noteIds) || noteIds.length === 0 || noteIds.length > NOTE_ID_RESOLVE_MAX) {
        throw new ControlPlaneError("note id resolve needs 1 to 200 note ids");
      }
      const parsed = await post("/gateway/note-ids/resolve", {
        workspaceId,
        noteIds,
        accessToken,
        expectedWorkspaceId: workspaceId,
      });
      const paths = required(parsed, "paths");
      if (!paths || typeof paths !== "object" || Array.isArray(paths)) {
        throw new ControlPlaneError("malformed note id paths");
      }
      const narrowed = {};
      for (const noteId of [...new Set(noteIds)]) {
        const path = paths[noteId];
        narrowed[noteId] = typeof path === "string" && path !== "" ? path : null;
      }
      return { paths: narrowed };
    },

    /**
     * Record a keyed write (`/gateway/note-ids/wrote`): the key's new version,
     * its size and when it landed (`at`), on the row itself. `recorded` says
     * whether the control plane kept it: false when the row has moved on
     * since, which is not an error.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {{path: string, key: string, etag: string, keyed?: boolean, size?: number, at?: number}} copy
     * @returns {Promise<{recorded: boolean}>}
     */
    async noteIdWrote(accessToken, workspaceId, copy) {
      const parsed = await post("/gateway/note-ids/wrote", {
        workspaceId,
        path: copy?.path,
        key: copy?.key,
        etag: copy?.etag,
        ...(copy?.keyed === true ? { keyed: true } : {}),
        ...(Number.isFinite(copy?.size) ? { size: copy.size } : {}),
        ...(Number.isFinite(copy?.at) ? { at: copy.at } : {}),
        accessToken,
        expectedWorkspaceId: workspaceId,
      });
      if (parsed.ok !== true) throw new ControlPlaneError("malformed note id record");
      return { recorded: parsed.recorded === true };
    },

    /**
     * Ask for the row of a note the gateway just created at its own id key
     * (`/gateway/note-ids/adopt`). `adopted: false` with `taken` names who
     * holds the name now; `taken: null` is a plain refusal.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {{path: string, noteId: string, key: string, etag: string, size?: number, at: number}} note
     * @returns {Promise<{adopted: boolean, taken: object|null}>}
     */
    async noteIdAdopt(accessToken, workspaceId, note) {
      const parsed = await post("/gateway/note-ids/adopt", {
        workspaceId,
        path: note?.path,
        noteId: note?.noteId,
        key: note?.key,
        etag: note?.etag,
        ...(Number.isFinite(note?.size) ? { size: note.size } : {}),
        at: note?.at,
        accessToken,
        expectedWorkspaceId: workspaceId,
      });
      if (parsed.ok !== true) throw new ControlPlaneError("malformed note adoption");
      if (parsed.adopted === true) return { adopted: true, taken: null };
      return { adopted: false, taken: narrowNote(parsed.taken) };
    },

    /**
     * Retire a keyed note's row (`/gateway/note-ids/removed`): the note is
     * gone from that moment, whatever happens to its bytes after.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {{path: string, key: string, at: number}} note
     * @returns {Promise<{removed: boolean}>}
     */
    async noteIdRemoved(accessToken, workspaceId, note) {
      const parsed = await post("/gateway/note-ids/removed", {
        workspaceId,
        path: note?.path,
        key: note?.key,
        at: note?.at,
        accessToken,
        expectedWorkspaceId: workspaceId,
      });
      if (parsed.ok !== true) throw new ControlPlaneError("malformed note removal");
      return { removed: parsed.removed === true };
    },
  };
}
