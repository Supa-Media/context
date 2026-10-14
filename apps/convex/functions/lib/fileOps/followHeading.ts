/**
 * A renamed note's first heading follows its new name, inside the rename.
 *
 * A note's heading is its name (decided by the owner, 2026-10-14). The
 * console used to rewrite the heading itself, as a second write after the move
 * answered (`followTitle`): read the note at its new name, rewrite the line,
 * write it back. By then the editor had moved on to the new name and the
 * device's own owed renames were still running, so two writers could rewrite
 * one heading at once, and the collaborative merge kept both — a note in
 * @seyi's kings folder came out titled "kkingsngs-6" (2026-10-14, see
 * `docs/decisions/app-and-console/one-name.md`).
 *
 * Here it is one more step of the move, before the move answers, against the
 * exact version the move produced: if anything has written to the note since
 * (an editor, an agent), the heading is left alone rather than raced. The
 * console asks for it only when the note on screen holds no typing the move
 * had to carry, the same condition its own rewrite had.
 */

import { retitled } from "@context/shared/src/linkedHeading";
import type { Clearance } from "../clearance";
import { isEncryptedNote } from "../noteEncryption";
import { FileOpError } from "./errors";
import type { MoveResult } from "./moving";
import type { FileStore } from "./store";
import { writeFile } from "./writing";

/**
 * The note's new etag when its heading was rewritten, `undefined` when nothing
 * changed: a folder or a queued move, a note with no heading or an address
 * name, an encrypted note, or a note somebody wrote to after the move.
 */
export async function followHeading(
  store: FileStore,
  moved: MoveResult,
  options: { clearance: Clearance; now: number },
): Promise<string | undefined> {
  if (moved.queued !== undefined || moved.etag === undefined || moved.paths.length !== 1) return undefined;
  if (moved.paths[0] !== moved.to) return undefined;
  const object = await store.get(moved.to);
  // Written since the move made it: that writer's text stands.
  if (object === null || object.etag !== moved.etag) return undefined;
  const text = await object.text();
  if (isEncryptedNote(text)) return undefined;
  const next = retitled(moved.from, moved.to, text);
  if (next === null) return undefined;
  try {
    const written = await writeFile(store, {
      path: moved.to,
      text: next,
      expectedEtag: moved.etag,
      clearance: options.clearance,
      now: options.now,
    });
    return written.etag;
  } catch (error) {
    // The rename has happened either way; a heading that could not follow is
    // a note whose two names differ, which the next title edit links again.
    if (error instanceof FileOpError) return undefined;
    throw error;
  }
}
