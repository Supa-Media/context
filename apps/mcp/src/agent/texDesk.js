/**
 * About me and the jobs list, read with the history in one call to the
 * person's Tex object (`texStore/desk.js`; the owner, 2026-11-01: one copy in
 * the object, no second copy anywhere, nothing read from storage on a text).
 *
 * Both notes keep their text in the person's object already (`tex-durable-
 * objects.md`). Read as any note is, each asked the control plane where it
 * lives first; so after each kept exchange, behind the reply, their keys are
 * looked up once (`store.keysAt`, `idLayout.js`) and kept in the history
 * record (`direct`), and the next turn's desk answers their text by key.
 * Anything that does not match (no key kept, a key that is not this person's
 * own object's note, a note with nothing under its key) is read the old way.
 * Writes always go through the note tools.
 *
 * Only on the person's own connection to their personal workspace, as its
 * owner with the private tier (`deskEligible`): that connection sees every
 * note there, so reading by key shows nothing `read_note` would not.
 */

import { ABOUT_ME_PATH } from "./aboutMe.js";
import { JOBS_PATH } from "./jobs.js";
import { deskNotes, keepDeskKeys } from "./history.js";
import { splitTexKey } from "../store/texRouting.js";

const PATHS = { about: ABOUT_ME_PATH, jobs: JOBS_PATH };

/** Whether this connection may read the desk's notes by key: its own personal workspace, as owner, private tier. */
export function deskEligible(store) {
  const current = (Array.isArray(store?.contexts) ? store.contexts : []).find((entry) => entry?.current === true);
  return current?.kind === "personal" && current.role === "owner" && current.tier === "private";
}

/** The desk's text for each note it read (`about`, `jobs`): `""` for a note the record says is missing, absent to read the old way. */
export async function deskTexts(store) {
  if (!deskEligible(store)) return {};
  const notes = await deskNotes(store);
  const texts = {};
  for (const name of Object.keys(PATHS)) {
    const note = notes[name];
    if (note === false) texts[name] = "";
    else if (typeof note?.text === "string") texts[name] = note.text.trim();
  }
  return texts;
}

/**
 * Look the notes' keys up and keep them in the record, behind the reply. Only
 * a key of a note in this person's own object, or false for a path with no
 * live note. Never throws.
 */
export async function learnDeskKeys(store, workspaceId) {
  try {
    if (!deskEligible(store) || typeof store?.keysAt !== "function") return;
    const keys = await store.keysAt(Object.values(PATHS));
    const direct = {};
    for (const [name, path] of Object.entries(PATHS)) {
      const key = keys?.[path];
      if (key === false) direct[name] = false;
      const split = typeof key === "string" ? splitTexKey(key) : null;
      if (split !== null && split.owner === `person:${workspaceId}` && split.key.startsWith("notes/") && split.key.endsWith(".md")) direct[name] = split.key;
    }
    await keepDeskKeys(store, direct);
  } catch {
    // The next turn reads these notes the old way.
  }
}
