/**
 * Tex inside a note: the contract between the editor and the gateway's
 * headless note run, and the one facet the editor reads it through.
 *
 * A Tex run in a note is always a comment thread. The selection toolbar's Tex
 * button (⌘L) opens a comment prefilled "@Tex ", the comment button (⌘M) a
 * plain one, and either thread brings Tex in whenever a message names @Tex
 * (Dev2, 2026-11-20, mock https://claude.ai/artifact/G8Udcec7fUh8jD7dnHkUN7).
 *
 * The gateway half is `POST /tex/note-run` (section D1). It streams what Tex
 * does and returns its answer and, when asked for a change, the whole new
 * text for the highlighted words. It never writes the note and never writes
 * the person's 1:1 chat: **the editor writes Tex's lines** into the note's
 * comments block (`- <at> Tex: …` and `- <at> Tex suggests: "…"`), through the
 * live collaboration binding, so everyone in the note sees the suggestion at
 * once and no server write races the open editor. Keep and Undo are the
 * person's own lines (`kept`, `undid`; `packages/shared/src/comments.cjs`).
 *
 * The run uses the asker's own access: Sayo's run reads what Sayo can see.
 */

import { Facet } from "@codemirror/state";

/** The author Tex's lines are signed with. No `@`, so `isPerson` reads it as an agent. */
export const TEX_AUTHOR = "Tex";

/** One message of the thread so far, oldest first, as the run is told it. */
export interface NoteRunTurn {
  who: string;
  body: string;
}

/** What the editor sends to start a run. */
export interface NoteRunRequest {
  /** The workspace id the note lives in. */
  workspace: string;
  noteId: string;
  path: string;
  /** The comment thread the run belongs to. */
  thread: string;
  /** The highlighted words ("" at a bare caret) and up to 200 characters either side. */
  anchor: { text: string; before: string; after: string };
  /** The message that brought Tex in, with "@Tex" taken out. */
  ask: string;
  history: NoteRunTurn[];
  /** Tex's pending suggestion when this run revises it, else null. */
  pending: string | null;
}

/** One line of the run's NDJSON stream. */
export type NoteRunEvent =
  | { type: "step"; id: string; label: string; state: "running" | "done"; ms?: number; source?: string }
  | { type: "answer"; text: string }
  /** The whole new text for the anchored words; a later one supersedes an earlier one. */
  | { type: "edit"; replace: string }
  | { type: "done"; runId: string; sources: string[] }
  | { type: "error"; message: string };

/** One row of the note's "Tex in this note" log, as `GET /tex/note-runs` lists it. */
export interface NoteRunRow {
  runId: string;
  /** The asker's `@handle`. */
  who: string;
  ask: string;
  /** One line on what Tex did. */
  out: string;
  sources: string[];
  /** ISO time. */
  at: string;
  /** True when the run used something only the asker can see. */
  private: boolean;
}

/** Somebody who can be @-mentioned in a thread, besides Tex. */
export interface Mentionable {
  /** `@handle`. */
  handle: string;
  /** What the menu shows. */
  name: string;
}

/**
 * What the surface around the editor gives Tex in a note. Absent (the
 * facet's default) means no Tex here: a guest page, a signed-out visitor, a
 * note with no room. The Tex button is then not drawn; comments still work.
 */
export interface TexInNoteHost {
  /** Start a run. Yields the stream's events and ends after `done` or `error`; never throws. */
  run(request: NoteRunRequest, signal: AbortSignal): AsyncIterable<NoteRunEvent>;
  /** The note's log, or a sentence saying why it could not be read. */
  runs(): Promise<NoteRunRow[] | { error: string }>;
  /** The note being edited, for the request. */
  note(): { workspace: string; noteId: string; path: string } | null;
  /** People the mention menu offers after Tex. */
  people(): Mentionable[];
  /** Told when a run in this editor finishes, so the log can refresh. */
  onRunDone?(runId: string): void;
  /** Told when Tex starts or stops working in this note, for the presence avatar. */
  onRunning?(running: boolean): void;
}

export const texInNoteHost = Facet.define<TexInNoteHost | null, TexInNoteHost | null>({
  combine: (values) => values.find((value) => value !== null) ?? null,
});
