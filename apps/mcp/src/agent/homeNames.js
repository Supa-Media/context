/**
 * The names a chat home's own notes go by: the same as a person's Tex folder
 * (decided by the owner, 2026-11-01: "1:1 tex folders and group tex folders
 * ... i would like them to mirror"; `docs/decisions/texting-assistant/tex-folders.md`).
 *
 * Until then a home kept `chat-<key>.md` (its history page), `voice-<key>.md`
 * and `about-us.md`, where a person's folder has `about-me.md`. Both sides now
 * say `history.md`, `voice.md` and `about.md`. The rows are renamed once
 * (`apps/convex/functions/texFolderNames.ts`), which keeps every note's key,
 * so a note read straight from the chat's object (`groupDirectNotes.js`) is
 * the same note after it. Until the rename has run everywhere, a name with
 * nothing under it is looked for under its old one, and a note found only
 * there is written there, so no turn starts a second copy beside it.
 */

/** A home's notes, by what each is for. */
export const HOME_NOTES = Object.freeze({ memory: "history.md", voice: "voice.md", about: "about.md" });

/** Each note's path in the home `folder`. */
export function homeNotePaths(folder) {
  return { memory: `${folder}/${HOME_NOTES.memory}`, voice: `${folder}/${HOME_NOTES.voice}`, about: `${folder}/${HOME_NOTES.about}` };
}

/** Each note's path before the rename, for the chat whose key hashes to `keyHash`. */
export function oldHomeNotePaths(folder, keyHash) {
  const id = String(keyHash).slice(0, 12);
  return { memory: `${folder}/chat-${id}.md`, voice: `${folder}/voice-${id}.md`, about: `${folder}/about-us.md` };
}

/**
 * `read(path)`'s answer for the new name, or for the old one when the new holds nothing and the old does, with the
 * path it came from. `read` answers `{missing}` for a name with no note and null when it could not say: an
 * unreadable new name is never read past.
 */
export async function readEitherName(read, path, old) {
  const seen = await read(path);
  if (seen === null || seen?.missing !== true || typeof old !== "string") return { seen, path };
  const was = await read(old);
  return was !== null && was?.missing !== true ? { seen: was, path: old } : { seen, path };
}

/**
 * A home's note names for this turn, from the record's `direct.old` (which notes the last lookup found only under
 * their old names, `learnDirect`): `{paths, old, live}`, or null with no home.
 */
export function homeNamesOf(group, keyHash, record) {
  if (!group?.home) return null;
  const paths = homeNotePaths(group.home.folder);
  const old = oldHomeNotePaths(group.home.folder, keyHash);
  const stillOld = new Set(Array.isArray(record?.direct?.old) ? record.direct.old : []);
  const live = Object.fromEntries(Object.keys(paths).map((which) => [which, stillOld.has(which) ? old[which] : paths[which]]));
  return { paths, old, live };
}
