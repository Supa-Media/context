/**
 * The rows a reader holds only to view: read, never changed.
 *
 * A Tex guest chat reads only what is shared with its group
 * (`apps/convex/functions/lib/nodes/chatFolders.ts`), and a row shared with
 * the group to view arrives as `team` in its rules, beside the rows shared to
 * edit. The control plane names the view-only ones in the rules' `readOnly`,
 * and the nearest setting decides, as it does for reading: a note with its
 * own setting answers for itself, and anything else for the nearest folder.
 * Paths are compared without case, so a second spelling of a view-only path
 * is refused too rather than written.
 */

const fold = (path) => String(path ?? "").toLowerCase();

/**
 * Whether `path` is held only to view, by the held rules (`{folders, notes, readOnly?}` as the control plane renders
 * them). False wherever the rules name no `readOnly`, which is every reader but a guest chat.
 */
export function readOnlyAt(held, path) {
  const readOnly = held?.readOnly;
  if (!readOnly || typeof path !== "string") return false;
  const key = fold(path);
  const notes = (readOnly.notes ?? []).map(fold);
  if ((held.notes ?? []).some((note) => fold(note.path) === key)) return notes.includes(key);
  let nearest = null;
  for (const folder of held.folders ?? []) {
    const prefix = fold(folder.prefix);
    if ((key === prefix || key.startsWith(`${prefix}/`)) && (nearest === null || prefix.length > nearest.length)) nearest = prefix;
  }
  return nearest !== null && (readOnly.folders ?? []).map(fold).includes(nearest);
}

/** The refusal a change to a view-only row gets, from the store or a tool. */
export function readOnlyRow(path) {
  return Object.assign(new Error(`${path} is shared with this chat to view only, so it can't be changed from here.`), {
    code: "READ_ONLY_ROW",
  });
}
