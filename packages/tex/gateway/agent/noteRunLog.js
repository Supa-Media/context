/**
 * The gateway's side of a note's run log (`texChat/noteRuns.js`): the note's own TexChat object, named
 * `noteruns:<workspaceId>:<noteId>`, reached the way the chat objects are (`objectByName`). Every call names the object
 * in a header, which the object checks against what it was first given. Failures are answered as null or false and
 * logged by name only, never by the words in them.
 */

import { objectByName } from "../../../../apps/mcp/src/objectPlace.js";
import { NOTE_RUNS_NAME_HEADER, NOTE_RUNS_PATH, NOTE_RUNS_PREFIX } from "../texChat/noteRuns.js";

/** The object's name for one note's log. */
export function noteRunsName(workspaceId, noteId) {
  return `${NOTE_RUNS_PREFIX}${workspaceId}:${noteId}`;
}

/** The note's log object, or null without the binding. */
function logOf(env, workspaceId, noteId) {
  if (env?.TEX_CHAT === undefined) return null;
  const name = noteRunsName(workspaceId, noteId);
  return { name, stub: objectByName(env.TEX_CHAT, name) };
}

/** Appends one run. True when the object kept it. */
export async function appendNoteRun(env, workspaceId, noteId, entry) {
  const log = logOf(env, workspaceId, noteId);
  if (log === null) return false;
  try {
    const answer = await log.stub.fetch(new Request(`https://chat${NOTE_RUNS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [NOTE_RUNS_NAME_HEADER]: log.name },
      body: JSON.stringify(entry),
    }));
    if (!answer.ok) console.log(JSON.stringify({ event: "note_run_log", outcome: answer.status }));
    return answer.ok;
  } catch (error) {
    console.log(JSON.stringify({ event: "note_run_log", outcome: "failed", error: String(error?.name ?? "error").slice(0, 40) }));
    return false;
  }
}

/** The note's runs, newest first, as the object keeps them; null when the log cannot be read. */
export async function listNoteRuns(env, workspaceId, noteId) {
  const log = logOf(env, workspaceId, noteId);
  if (log === null) return null;
  try {
    const answer = await log.stub.fetch(new Request(`https://chat${NOTE_RUNS_PATH}`, { method: "GET", headers: { [NOTE_RUNS_NAME_HEADER]: log.name } }));
    if (!answer.ok) return null;
    const { runs } = await answer.json();
    return Array.isArray(runs) ? runs : [];
  } catch (error) {
    console.log(JSON.stringify({ event: "note_run_log", outcome: "unreadable", error: String(error?.name ?? "error").slice(0, 40) }));
    return null;
  }
}
