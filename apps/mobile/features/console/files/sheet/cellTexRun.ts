/**
 * Tex in a sheet cell's thread: the request a run is asked with and the
 * reading of its stream. The same gateway run a note's thread uses
 * (`comments/tex/runner.ts`, `POST /tex/note-run`), told the cell (`cell`), and
 * answering with changes to the sheet (`sheet` events) rather than new words.
 *
 * Nothing here writes. `CellComments` applies the answer and the changes to
 * the sheet through the grid's own save, as one step (`applyTexAnswer`).
 */

import type { CommentThread } from "@context/shared/src/comments.cjs";
import type { NoteRunEvent, NoteRunRequest, TexInNoteHost } from "../comments/tex/contract";
import type { SheetChanges } from "./cellNotes";

export const TEX_FAILED = "Tex couldn't finish this. Try again.";

/** What the gateway is told: the cell, its value and the thread so far. "@Tex" is taken out of the ask. */
export function cellRequest(
  note: { workspace: string; noteId: string; path: string },
  at: { row: number; column: string; value: string },
  thread: CommentThread,
  ask: string,
): NoteRunRequest {
  return {
    workspace: note.workspace,
    noteId: note.noteId,
    path: note.path,
    thread: thread.id,
    anchor: { text: at.value.slice(0, 20_000), before: "", after: "" },
    ask: ask
      .replace(/(^|\s)@tex\b/gi, "$1")
      .replace(/\s{2,}/g, " ")
      .trim(),
    history: thread.events.filter((e) => e.kind === "comment").map((e) => ({ who: e.author, body: e.text })).slice(-20),
    pending: null,
    cell: { row: at.row, column: at.column },
  };
}

export type CellRunOutcome = { answer: string; changes: SheetChanges | null; runId: string | null } | { error: string };

/** Read a run to its end: steps are told as they come, and the answer and changes are returned. Never throws. */
export async function readCellRun(
  host: TexInNoteHost,
  request: NoteRunRequest,
  signal: AbortSignal,
  onStep: (label: string) => void,
): Promise<CellRunOutcome> {
  let answer: string | null = null;
  let changes: SheetChanges | null = null;
  let runId: string | null = null;
  try {
    for await (const event of host.run(request, signal) as AsyncIterable<NoteRunEvent>) {
      if (signal.aborted) return { error: TEX_FAILED };
      if (event.type === "step") {
        if (event.state === "running" || event.id === "step-think") onStep(event.label);
      } else if (event.type === "answer") answer = event.text;
      else if (event.type === "sheet") changes = event.changes;
      else if (event.type === "done") runId = event.runId;
      else if (event.type === "error") return { error: event.message || TEX_FAILED };
    }
  } catch {
    return { error: TEX_FAILED };
  }
  if (answer === null && changes === null) return { error: TEX_FAILED };
  return { answer: answer !== null && answer.trim() !== "" ? answer : "Done.", changes, runId };
}
