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
import { readFile } from "./reading";
import type { FileStore } from "./store";
import { writeFile } from "./writing";

/**
 * The version a read of the renamed note hands out once its heading has followed: the written version, or
 * the version read when nothing needed writing. `undefined` when this step did not read the note at all (a
 * folder, a queued move) or the read failed, and when somebody wrote to the note after the move: the caller
 * then asks for the version itself.
 *
 * Never throws. The rename has landed before this runs, so a failure here — a refusal, or the bucket not
 * answering — leaves a note whose heading and name differ, which the next title edit links again; failing
 * the rename for it told the app a move had not happened when it had (2026-10-29).
 */
export async function followHeading(
  store: FileStore,
  moved: MoveResult,
  options: { clearance: Clearance; now: number },
): Promise<string | undefined> {
  // A row move (`rowed`) has landed whole; only a queued one still has its bucket catching up.
  if ((moved.queued !== undefined && moved.rowed !== true) || moved.etag === undefined || moved.paths.length !== 1) return undefined;
  if (moved.paths[0] !== moved.to) return undefined;
  try {
    // Read as every open reads it, so a collaborative note's version is its
    // document's. The move answered with the row's Markdown etag (`handOut: false`,
    // so it did not read the note too), or with the version a read hands out.
    const current = await readFile(store, { path: moved.to, clearance: options.clearance, forward: "never" });
    // Written since the move made it: that writer's text stands.
    if (current.etag !== moved.etag && current.rawEtag !== moved.etag) return undefined;
    const text = current.text;
    if (isEncryptedNote(text)) return current.etag;
    const next = retitled(moved.from, moved.to, text);
    if (next === null) return current.etag;
    const written = await writeFile(store, {
      path: moved.to,
      text: next,
      expectedEtag: current.etag,
      clearance: options.clearance,
      now: options.now,
    });
    return written.etag;
  } catch (error) {
    console.warn(JSON.stringify({ event: "rename.heading_not_followed", error: String((error as Error)?.name ?? "Error"), code: error instanceof FileOpError ? error.code : null }));
    return undefined;
  }
}
