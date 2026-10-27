/**
 * A trashed note's text, for the console to show it in place, read-only, when
 * the note is opened by an address that outlived it (`?note=` on a reload;
 * design A in project file `trashed-note/`).
 *
 * THE TRASH KEY IS PLUMBING, AND THIS DOES NOT CHANGE THAT. `canSee` refuses
 * every `.context/` key at every scope, and nothing here asks it about one.
 * The question is asked about the note's own name, judged by the live rules,
 * exactly as Restore asks it (`restoreTrashedPath`): a note held back from
 * this caller is not found, in the trash or out of it. The key is accepted
 * only when it is the trash's copy of that very note (`.context/trash/<stamp>/
 * <path>`), and the one caller (`trashedNotes.readTrashedNote`) sends the key
 * the audit trail named, never one a client chose.
 *
 * The trash's row is where the note is now (`rowTrash.ts`): the read follows
 * its key, and nothing is moved.
 */

import { isEncryptedNote } from "../noteEncryption";
import { canSee } from "../privacy";
import type { Clearance } from "../clearance";
import { notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { TRASH_ROOT, type FileStore } from "./store";
import { assertWritablePath } from "./writing";

const TRASH_KEY = /^\.context\/trash\/[^/]+\/(.+)$/;

export async function readTrashedText(
  store: FileStore,
  options: { path: string; trash: string; clearance: Clearance },
): Promise<{ kind: "trashedText"; path: string; text: string; encrypted: boolean }> {
  const path = requirePath(options.path);
  assertWritablePath(path);
  const match = options.trash.startsWith(`${TRASH_ROOT}/`) ? TRASH_KEY.exec(options.trash) : null;
  if (match === null || match[1] !== path) throw notFound();
  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
  const object = await store.get(options.trash);
  if (object === null) throw notFound();
  const text = await object.text();
  return { kind: "trashedText", path, text, encrypted: isEncryptedNote(text) };
}
