/**
 * A chat's note, carried to the name it keeps from now on (the owner, 2026-10-31, reversing 2026-10-23: one memory per
 * chat, shared with whoever is added later).
 *
 * The memory and voice notes were named by the people in the chat (`chat-<people>.md`), so a newcomer started a new one.
 * They are named by the chat's key alone now. The first turn after the change moves the old note under the new name:
 *
 *  - copy: the old words are written under the new name, then read back, and only a read-back that matches goes on;
 *  - retract: only then is the old note archived (`archive_note`, with the etag the copy was made from), so a change
 *    made to it meanwhile refuses and nothing is lost. Never before the read-back matches.
 *
 * A note moved into a home (`chatHome.js`) is copied but never retracted: a home's notes are sealed to the chat's
 * people, and the only retraction this gateway has (`archive_note`) moves a note to the workspace's archive root,
 * outside the seal. The old home copy stays where it is, unread. The same goes for a guest chat's old note: its folder
 * is the chat's guests' alone, and an archive is team-visible.
 *
 * The move runs again on later turns while a retractable old note is still there. It retracts only when every line of
 * the old note is a line of the note it was carried to, so a retry never retracts words the new note lacks. Within one
 * turn a copy that was refused because the old note changed is copied again before that turn writes its exchange, so
 * only our own copy is ever overwritten.
 */

import { readWithEtag } from "./jobLog.js";

/** How many times one turn copies again, when the old note changed between the copy and its retraction. */
const ATTEMPTS = 3;

const trimmedEnd = (text) => String(text ?? "").replace(/\s+$/, "");

/** Every non-blank line of `words` is a line of `held`: nothing `words` says is lost by retracting it. */
export function linesCovered(words, held) {
  const lines = new Set(String(held).split("\n").map((line) => line.trim()));
  return String(words)
    .split("\n")
    .every((line) => line.trim() === "" || lines.has(line.trim()));
}

async function writeText(dispatch, path, content, etag) {
  try {
    const result = await dispatch("write_note", { path, content, ...(etag ? { expected_etag: etag } : {}) });
    return result?.isError !== true;
  } catch {
    return false;
  }
}

async function retract(note, etag) {
  try {
    const result = await note.dispatch("archive_note", { path: note.path, expected_etag: etag });
    return result?.isError !== true;
  } catch {
    return false;
  }
}

/** The first old name that holds a note: `{...source, etag, body}`, or null. An unreadable name is skipped, never guessed. */
async function firstHeld(sources) {
  for (const source of sources) {
    const read = await readWithEtag(source.dispatch, source.path);
    if (read !== null && read.missing !== true) return { ...source, etag: read.etag, body: read.body };
  }
  return null;
}

/**
 * Move the chat's note to `target` (`{dispatch, path}`) from the first of `sources` (`{dispatch, path, retract}`) that
 * holds one. `adapt` says how the words are written there (a home's intro). Returns `{outcome, fallback}`:
 *
 *  - "moved": copied, read back and the old note retracted;
 *  - "copied": copied and read back, and the old note stays (a home's, or one not retractable);
 *  - "kept": nothing was retracted, and the next turn tries again. `fallback` is the old words when the target is still
 *    missing, so this turn's answer still reads the memory it had;
 *  - "none": no old note exists, so there is nothing to do.
 */
export async function moveChatNote({ target, sources, adapt = (text) => text, log = console.log }) {
  // The target and every retractable old name side by side: once moved, each turn reads them all and finds only the target.
  const retractable = sources.filter((entry) => entry.retract === true);
  const [here, ...olds] = await Promise.all([target, ...retractable].map((entry) => readWithEtag(entry.dispatch, entry.path)));
  // Unreadable: never write over a note that may be there.
  if (here === null) return { outcome: "kept", fallback: null };

  if (here.missing !== true) {
    // The target already holds the chat's note (`held`, so the caller need not read it again). Only a retractable old name whose every line it holds may go.
    const held = { etag: here.etag, body: here.body };
    for (const [i, source] of retractable.entries()) {
      const old = olds[i];
      if (old === null || old.missing === true) continue;
      if (!linesCovered(adapt(old.body), here.body)) {
        log(JSON.stringify({ event: "chat_note_kept", reason: "not_covered" }));
        return { outcome: "kept", fallback: null, held };
      }
      return { outcome: (await retract(source, old.etag)) ? "moved" : "kept", fallback: null, held };
    }
    return { outcome: "kept", fallback: null, held };
  }

  const first = await firstHeld(sources);
  if (first === null) return { outcome: "none", fallback: null };

  let current = first;
  let copied = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const content = adapt(current.body);
    if (!(await writeText(target.dispatch, target.path, content, copied))) return { outcome: "kept", fallback: current.body };
    const back = await readWithEtag(target.dispatch, target.path);
    if (back === null || back.missing === true || trimmedEnd(back.body) !== trimmedEnd(content)) {
      log(JSON.stringify({ event: "chat_note_kept", reason: "read_back_differs" }));
      return { outcome: "kept", fallback: current.body };
    }
    copied = back.etag;
    if (current.retract !== true) return { outcome: "copied", fallback: null };
    if (await retract(current, current.etag)) return { outcome: "moved", fallback: null };
    // Refused: the old note changed since it was read, or this layout refuses the move. Only a change is copied again.
    const again = await readWithEtag(current.dispatch, current.path);
    if (again === null) return { outcome: "kept", fallback: null };
    if (again.missing === true) return { outcome: "moved", fallback: null };
    if (again.etag === current.etag) return { outcome: "kept", fallback: null };
    current = { ...current, etag: again.etag, body: again.body };
  }
  return { outcome: "kept", fallback: null };
}
