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
 * While the trash is still queued the bucket has not moved the note yet, so
 * the read folds through the pending moves (`physicalCandidates`): the object
 * is wherever the move has it now, and it is read without moving it.
 */

import { isEncryptedNote } from "../noteEncryption";
import { canSee } from "../privacy";
import type { Clearance } from "../clearance";
import { pendingMovesOf, physicalCandidates, readAtTreeName } from "../../../../mcp/src/moves/queued.js";
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
  const pending = pendingMovesOf((store as { pendingMoves?: unknown }).pendingMoves);
  for (const key of physicalCandidates(options.trash, pending)) {
    // Only an object that folds to this trash key: the note, wherever its move has it now.
    const object = await readAtTreeName(store, key, (named: string) => named === options.trash);
    if (object === null || object === undefined) continue;
    const text = await object.text();
    return { kind: "trashedText", path, text, encrypted: isEncryptedNote(text) };
  }
  throw notFound();
}
