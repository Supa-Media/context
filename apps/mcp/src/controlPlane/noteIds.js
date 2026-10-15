/**
 * Where each note's bytes live, read and recorded by the control plane while
 * the layout is "ids" or "keys" (`store/idLayout.js`, and
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
 * needs a real id key and a version; anything malformed is dropped, which the
 * layer reads as "no row" in a workspace that is not keyed and refuses in one
 * that is (the lookup then names no note there, so a read finds nothing).
 */
function narrowNote(entry) {
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
      if (typeof entry.key !== "string" || entry.key === "") return null;
      return { state: "path", key: entry.key, etag: text(entry.etag), keyEtag: text(entry.keyEtag), fresh: entry.fresh === true };
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

export function createNoteIdMethods({ post, required }) {
  return {
    /**
     * Where each path's id copy is, and whether it is fresh
     * (`/gateway/note-ids/lookup`). Paths with no live row are absent from
     * `copies`. Entries without a usable key are dropped, and an `etag` that
     * is not a string reads as `null`.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {string[]} paths
     * @returns {Promise<{copies: Record<string, {key: string, etag: string|null, keyEtag: string|null, fresh: boolean}>}>}
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
      const copies = required(parsed, "copies");
      if (!copies || typeof copies !== "object" || Array.isArray(copies)) {
        throw new ControlPlaneError("malformed note id copies");
      }
      const narrowed = {};
      for (const path of Object.keys(copies)) {
        const copy = copies[path];
        if (!copy || typeof copy !== "object") continue;
        if (typeof copy.key !== "string" || copy.key === "") continue;
        narrowed[path] = {
          key: copy.key,
          etag: typeof copy.etag === "string" && copy.etag !== "" ? copy.etag : null,
          keyEtag: typeof copy.keyEtag === "string" && copy.keyEtag !== "" ? copy.keyEtag : null,
          fresh: copy.fresh === true,
        };
      }
      // `keyed` and `notes` arrive from a control plane that knows keyed rows;
      // an older one sends `copies` only, which the layer reads as before.
      if (parsed.notes === undefined) return { copies: narrowed };
      if (!parsed.notes || typeof parsed.notes !== "object" || Array.isArray(parsed.notes)) {
        throw new ControlPlaneError("malformed note id entries");
      }
      const notes = {};
      for (const path of Object.keys(parsed.notes)) {
        const entry = narrowNote(parsed.notes[path]);
        if (entry !== null) notes[path] = entry;
      }
      return { copies: narrowed, keyed: parsed.keyed === true, notes };
    },

    /**
     * Record that the id copy at `key` holds the path's version `etag`
     * (`/gateway/note-ids/wrote`). `recorded` says whether the control plane
     * kept it: false when the row has moved on since, which is not an error.
     * A keyed write (`keyed: true`) records the key's new version, its size and
     * when it landed (`at`) on the row itself.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {{path: string, key: string, etag: string, keyEtag?: string, keyed?: boolean, size?: number, at?: number}} copy
     * @returns {Promise<{recorded: boolean}>}
     */
    async noteIdWrote(accessToken, workspaceId, copy) {
      const parsed = await post("/gateway/note-ids/wrote", {
        workspaceId,
        path: copy?.path,
        key: copy?.key,
        etag: copy?.etag,
        ...(typeof copy?.keyEtag === "string" && copy.keyEtag !== "" ? { keyEtag: copy.keyEtag } : {}),
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
