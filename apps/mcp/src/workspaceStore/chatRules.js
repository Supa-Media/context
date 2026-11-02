/**
 * The rules a Tex guest chat reads a workspace by, rendered in the workspace's object from the guest rules it holds,
 * exactly as the control plane renders them (`apps/convex/functions/lib/nodes/chatFolders.ts` `chatRules`): a row
 * whose visibility is a row token the chat holds is `team`, every other row `private`. The gateway's chat reader is
 * then judged at its own scope with no names, as it is against the control plane's rendering.
 *
 * `chatNames` are the names the chat's grant holds (`session.workspaces[].grantedNames`), with or without `@`.
 */

/** The chat's names as tokens (`@#<id>`, `@#<id>!edit`), or null where they are not a list of names. */
export function chatTokens(chatNames) {
  if (!Array.isArray(chatNames) || chatNames.some((name) => typeof name !== "string")) return null;
  return new Set(chatNames.map((name) => (name.startsWith("@") ? name : `@${name}`)));
}

/** `held` (the guest rules, `{folders, notes, accessVersion}`) as the chat holding `tokens` reads them. */
export function chatRulesFrom(held, tokens) {
  const read = (visibility) => (typeof visibility === "string" && visibility.startsWith("@#") && tokens.has(visibility) ? "team" : "private");
  return {
    accessVersion: held.accessVersion,
    folders: held.folders.map((folder) => ({ prefix: folder.prefix, visibility: read(folder.visibility) })),
    notes: held.notes.map((note) => ({ path: note.path, visibility: read(note.visibility) })),
  };
}
