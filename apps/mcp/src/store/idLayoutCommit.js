/**
 * The id layer's door for a live edit committed in the workspace object in one call (`workspaceRouting.js`
 * `commitInObject`, `workspaceStore/collabReplace.js` `serveCollabCommit`), for a keyed note: the object is told the
 * key and note id this layer resolved and refuses if its row says otherwise. The new Markdown version is reported as a
 * replacement's is (`idLayout.js` `replaceInObject`). The door answers `null` where the path is not a note's or the
 * object did not serve it, and the caller commits through the store as before.
 *
 * Kept beside `idLayout.js` rather than in it, which is at its size limit; it is handed the layer's own helpers.
 */
export function commitInObjectDoor({ store, mirroredPath, resolve, keyedEntry, wrote, report, now }) {
  return async (path, { documentId, update }) => {
    if (!mirroredPath(path)) return null;
    const { entry } = await resolve(path);
    if (!keyedEntry(entry) || typeof entry.noteId !== "string") return null;
    const answer = await store.commitInObject({
      path,
      key: entry.key,
      noteId: entry.noteId,
      documentId,
      update,
      ...(wrote.inObject === true ? { record: { at: now() } } : {}),
    });
    if (answer === null || answer.served !== true) return answer;
    const markdown = answer.markdown;
    if (typeof markdown?.etag === "string" && answer.recorded !== true) {
      await report({ path, key: entry.key, etag: markdown.etag, ...(Number.isFinite(markdown.size) ? { size: markdown.size } : {}), at: now(), keyed: true });
    }
    return answer;
  };
}
