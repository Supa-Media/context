/**
 * The id copies of notes, read and recorded by the control plane while the
 * workspace's layout is "ids" (`store/idLayout.js`, and
 * `docs/decisions/storage-and-credentials/notes-by-id.md`).
 *
 * Both calls spend the same two proofs `/gateway/tree/facts` does: the gateway
 * secret in the header, and the person's own access token in the body. The
 * control plane derives the workspace from that token's grant; the
 * `workspaceId` and `expectedWorkspaceId` fields only let it refuse a mismatch.
 */
import { ControlPlaneError } from "./client.js";

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
      return { copies: narrowed };
    },

    /**
     * Record that the id copy at `key` holds the path's version `etag`
     * (`/gateway/note-ids/wrote`). `recorded` says whether the control plane
     * kept it: false when the row has moved on since, which is not an error.
     *
     * @param {string} accessToken
     * @param {string} workspaceId
     * @param {{path: string, key: string, etag: string, keyEtag?: string}} copy
     * @returns {Promise<{recorded: boolean}>}
     */
    async noteIdWrote(accessToken, workspaceId, copy) {
      const parsed = await post("/gateway/note-ids/wrote", {
        workspaceId,
        path: copy?.path,
        key: copy?.key,
        etag: copy?.etag,
        ...(typeof copy?.keyEtag === "string" && copy.keyEtag !== "" ? { keyEtag: copy.keyEtag } : {}),
        accessToken,
        expectedWorkspaceId: workspaceId,
      });
      if (parsed.ok !== true) throw new ControlPlaneError("malformed note id record");
      return { recorded: parsed.recorded === true };
    },
  };
}
