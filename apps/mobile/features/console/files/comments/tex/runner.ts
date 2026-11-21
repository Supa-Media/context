/**
 * Tex runs inside a note: start one from a comment thread, stream its steps
 * into the thread, type its edit as it arrives, then write the edit straight
 * into the note and its answer into the thread. The person asked for the
 * edit, so there is nothing to accept: the edit is one step of the editor's
 * history, and ⌘Z takes it back (the answer in the thread stays).
 *
 * Tex's lines are written by the editor, not the gateway (see contract.ts):
 * the write goes through this editor's live binding, so everyone in the note
 * sees the edit at once and no server write races the open editor.
 *
 * Keep and Undo remain only for suggestions written before edits applied
 * directly; new runs never write one.
 */

import { peerTexRuns, texRelay } from "./peerRuns";
import { isolateHistory } from "@codemirror/commands";
import { ChangeSet, StateEffect, StateField, Transaction, type EditorState, type Extension, type TransactionSpec } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import {
  MARKER_RE,
  stripComments,
  appendEvent,
  keepSuggestion,
  type CommentChange,
  type CommentEvent,
  type CommentThread,
} from "@context/shared/src/comments.cjs";
import { commentHost, commentSent, commentsParsed } from "../extension";
import { TEX_AUTHOR, texInNoteHost, type NoteRunEvent, type NoteRunRequest, type TexInNoteHost } from "./contract";
import { pendingDecorations } from "./pending";
import { texEditFor } from "./edit";

export { texInNoteStyles } from "./pending";

/** A step as the thread shows it while Tex works. */
export type LiveStep = Extract<NoteRunEvent, { type: "step" }>;

/**
 * A run still going in this editor, keyed by thread id. A run that failed
 * stays here with `error` set until the next run on the thread starts.
 */
export interface TexRunLive {
  thread: string;
  /** What the working bubble says now ("Reading Grocery list"), from the latest running step. */
  label: string;
  steps: LiveStep[];
  /** The new words being typed into the note so far, or null before an edit arrives. */
  typing: string | null;
  /** A sentence to show in the thread when the run failed, else null. */
  error: string | null;
}

type RunMap = ReadonlyMap<string, TexRunLive>;

const DEFAULT_ERROR = "Tex couldn't finish this. Try again.";
const DONE_LINE = "Done.";
const CANT_COMMENT = "This note can't take comments here.";
const START_LABEL = "Reading";
/** Context either side of the words, in characters. */
const CONTEXT_CHARS = 200;
/**
 * Typing animation: two characters every 12ms, so a short change lands in
 * about a fifth of a second. A longer one is not animated (it would be a
 * minute of typing), it appears at once.
 */
const TYPE_CHUNK = 2;
const TYPE_STEP_MS = 12;
const TYPE_SKIP_OVER = 2000;

const runStarted = StateEffect.define<string>();
const runStepped = StateEffect.define<{ thread: string; step: LiveStep }>();
const runTyped = StateEffect.define<{ thread: string; typing: string | null }>();
const runFailed = StateEffect.define<{ thread: string; message: string }>();
/** `keepError` keeps a failed run's entry so the thread can show why it failed. */
const runEnded = StateEffect.define<{ thread: string; keepError: boolean }>();

/** The runs going on in this editor, keyed by thread id. */
export const texRuns = StateField.define<RunMap>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    const put = (thread: string, run: TexRunLive | null) => {
      const map = new Map(next);
      if (run === null) map.delete(thread);
      else map.set(thread, run);
      next = map;
    };
    for (const effect of tr.effects) {
      if (effect.is(runStarted)) {
        put(effect.value, { thread: effect.value, label: START_LABEL, steps: [], typing: null, error: null });
      } else if (effect.is(runStepped)) {
        const run = next.get(effect.value.thread);
        if (!run) continue;
        const { step } = effect.value;
        // A step is a row by id: a later line with the same id updates it.
        const steps = run.steps.some((s) => s.id === step.id) ? run.steps.map((s) => (s.id === step.id ? step : s)) : [...run.steps, step];
        put(run.thread, { ...run, steps, label: step.state === "running" ? step.label : run.label });
      } else if (effect.is(runTyped)) {
        const run = next.get(effect.value.thread);
        if (run) put(run.thread, { ...run, typing: effect.value.typing });
      } else if (effect.is(runFailed)) {
        const run = next.get(effect.value.thread);
        if (run) put(run.thread, { ...run, typing: null, error: effect.value.message });
      } else if (effect.is(runEnded)) {
        const run = next.get(effect.value.thread);
        if (!run) continue;
        if (effect.value.keepError && run.error !== null) put(run.thread, { ...run, typing: null });
        else put(run.thread, null);
      }
    }
    return next;
  },
});

/** Whether a message names Tex. */
export function mentionsTex(body: string): boolean {
  return /(^|[^\w@])@tex\b/i.test(body);
}

/**
 * Whether a message goes to Tex: it names @Tex, or Tex is already in the
 * thread and the message names nobody else. A follow-up like "make it 6pm"
 * then reaches Tex without being named again.
 */
export function shouldAskTex(thread: CommentThread | null, body: string): boolean {
  if (mentionsTex(body)) return true;
  if (thread === null) return false;
  const texIsIn = thread.events.some((event) => event.author === TEX_AUTHOR);
  return texIsIn && !/(^|\s)@\w/.test(body);
}

/** Each thread's controller for the run going on it, per editor. */
const controllers = new WeakMap<EditorView, Map<string, AbortController>>();

function runsOf(view: EditorView): Map<string, AbortController> {
  let map = controllers.get(view);
  if (!map) {
    map = new Map();
    controllers.set(view, map);
  }
  return map;
}

/** A host's callback must not stop a run, so its errors are dropped here. */
function tellHost(call: () => void): void {
  try {
    call();
  } catch {
    // The surface around the editor failed to hear about it; the run goes on.
  }
}

/** A dispatch that fails (the view was destroyed mid-run) is dropped, not thrown. */
function send(view: EditorView, spec: TransactionSpec): boolean {
  try {
    view.dispatch(spec);
    return true;
  } catch {
    return false;
  }
}

/** The text with comment markers removed: what a reader sees. */
function visibleWords(text: string): string {
  return text.replace(MARKER_RE, "");
}

/** What the gateway is told: the thread's words, its surroundings and the history. */
function requestFor(state: EditorState, thread: string, ask: string, note: { workspace: string; noteId: string; path: string }): NoteRunRequest | null {
  const parsed = state.field(commentsParsed, false);
  const found = parsed?.threads.find((t) => t.id === thread);
  if (parsed === undefined || found === undefined) return null;
  const anchor = parsed.anchors.get(thread);
  return {
    workspace: note.workspace,
    noteId: note.noteId,
    path: note.path,
    thread,
    anchor: {
      text: anchor ? visibleWords(state.sliceDoc(anchor.from, anchor.to)) : "",
      before: anchor ? visibleWords(state.sliceDoc(0, anchor.from)).slice(-CONTEXT_CHARS) : "",
      // The comments and mail blocks at the end are conversation about the
      // note, not the note: the history field carries this thread's part.
      after: anchor ? stripComments(state.sliceDoc(anchor.to)).slice(0, CONTEXT_CHARS) : "",
    },
    // "@Tex" is taken out of the ask, and only that: the rest of the words stay as written.
    ask: ask
      .replace(/(^|\s)@tex\b/gi, "$1")
      .replace(/\s{2,}/g, " ")
      .trim(),
    history: found.events.filter((e: CommentEvent) => e.kind === "comment").map((e) => ({ who: e.author, body: e.text })),
    pending: found.pending?.text ?? null,
  };
}

/** Start a run on `thread` for the message `ask` (already written to the thread). Never throws. */
export function startTexRun(view: EditorView, thread: string, ask: string): void {
  try {
    const host = view.state.facet(texInNoteHost);
    if (host === null) return;
    const note = host.note();
    if (note === null) return;
    const request = requestFor(view.state, thread, ask, note);
    if (request === null) return;
    const map = runsOf(view);
    // A new run on the thread replaces one still going; the old one writes nothing.
    map.get(thread)?.abort();
    const controller = new AbortController();
    map.set(thread, controller);
    send(view, { effects: runStarted.of(thread) });
    tellHost(() => host.onRunning?.(true));
    void drive(view, host, request, controller);
  } catch {
    // A failed start leaves the thread as the person wrote it.
  }
}

/** Stop the run on `thread`, if one is going. Nothing is written for it. */
export function stopTexRun(view: EditorView, thread: string): void {
  try {
    const controller = runsOf(view).get(thread);
    if (controller === undefined) return;
    controller.abort();
    finish(view, thread, controller);
    send(view, { effects: runEnded.of({ thread, keepError: false }) });
  } catch {
    // Nothing to stop.
  }
}

/** Forget a finished run and tell the host when none is left in this editor. */
function finish(view: EditorView, thread: string, controller: AbortController): void {
  const map = runsOf(view);
  if (map.get(thread) !== controller) return;
  map.delete(thread);
  if (map.size === 0) tellHost(() => view.state.facet(texInNoteHost)?.onRunning?.(false));
}

/** Read the run's stream, type its edit, and write what it said into the thread. */
async function drive(view: EditorView, host: TexInNoteHost, request: NoteRunRequest, controller: AbortController): Promise<void> {
  const { thread } = request;
  const current = () => runsOf(view).get(thread) === controller;
  let answer: string | null = null;
  let replace: string | null = null;
  let runId: string | null = null;
  let failure: string | null = null;
  try {
    for await (const event of host.run(request, controller.signal)) {
      // Stopped or superseded: the stream is dropped and nothing is written.
      if (!current()) return;
      if (event.type === "step") {
        send(view, { effects: runStepped.of({ thread, step: event }) });
      } else if (event.type === "answer") {
        answer = event.text;
      } else if (event.type === "edit") {
        replace = event.replace;
        await typeInto(view, thread, event.replace, current);
      } else if (event.type === "done") {
        runId = event.runId;
      } else if (event.type === "error") {
        failure = event.message || DEFAULT_ERROR;
        break;
      }
    }
  } catch {
    failure = DEFAULT_ERROR;
  }
  if (!current()) return;

  if (failure === null) {
    const written = tellNote(view.state, thread, answer, replace);
    if (written.error === undefined) {
      // The edit first, as its own step of the editor's history, so ⌘Z takes
      // back exactly what Tex wrote. The run ends in the same transaction, so
      // the typing preview and the written words never show together.
      const ended = runEnded.of({ thread, keepError: true });
      if (written.edit !== null) {
        send(view, {
          changes: written.edit,
          effects: ended,
          userEvent: "input.tex",
          annotations: isolateHistory.of("full"),
        });
      }
      // Then the answer in the thread, outside the history: undoing the edit
      // leaves what Tex said, and ⌘Z never has to step over Tex's reply.
      const said = written.edit === null ? written.said : tellThread(view.state, thread, written.body);
      if (said !== null && !said.empty) {
        send(view, {
          changes: said,
          effects: written.edit === null ? ended : [],
          userEvent: "input.comment",
          annotations: Transaction.addToHistory.of(false),
        });
      } else if (written.edit === null) {
        send(view, { effects: ended });
      }
      finish(view, thread, controller);
      const id = runId;
      if (id !== null) tellHost(() => host.onRunDone?.(id));
      return;
    }
    failure = DEFAULT_ERROR;
  }
  send(view, { effects: [runFailed.of({ thread, message: failure }), runEnded.of({ thread, keepError: true })] });
  finish(view, thread, controller);
}

/** Type `replace` into the note's decorations, two characters at a time. */
async function typeInto(view: EditorView, thread: string, replace: string, current: () => boolean): Promise<void> {
  if (replace.length > TYPE_SKIP_OVER) {
    send(view, { effects: runTyped.of({ thread, typing: replace }) });
    return;
  }
  for (let shown = 0; ; shown = Math.min(replace.length, shown + TYPE_CHUNK)) {
    if (!current()) return;
    send(view, { effects: runTyped.of({ thread, typing: replace.slice(0, shown) }) });
    if (shown >= replace.length) return;
    await new Promise<void>((resolve) => setTimeout(resolve, TYPE_STEP_MS));
  }
}

/**
 * What a finished run writes: the edit in the note (null when it changes
 * nothing or the thread's highlight is gone), the line Tex says in the thread,
 * and, when there is no edit, that line as changes against the current text.
 */
function tellNote(
  state: EditorState,
  thread: string,
  answer: string | null,
  replace: string | null,
):
  | { edit: { from: number; to: number; insert: string }[] | null; body: string; said: ChangeSet | null; error?: undefined }
  | { error: string } {
  try {
    const anchor = state.field(commentsParsed, false)?.anchors.get(thread);
    const found = replace !== null && anchor !== undefined ? texEditFor(state, anchor, replace) : null;
    const edit = found === null ? null : found.changes;
    const body = answer?.trim() || (edit !== null ? DONE_LINE : "");
    if (edit !== null) return { edit, body, said: null };
    return { edit, body, said: tellThread(state, thread, body) };
  } catch {
    return { error: DEFAULT_ERROR };
  }
}

/** Tex's line in the thread as changes against `state`, or null when there is nothing to say or it can't be written. */
function tellThread(state: EditorState, thread: string, body: string): ChangeSet | null {
  if (body === "") return null;
  try {
    const said = appendEvent(state.doc.toString(), { thread, kind: "comment", author: TEX_AUTHOR, body });
    if (said.error !== undefined) return null;
    return ChangeSet.of([...said.changes].sort((a, b) => a.from - b.from), state.doc.length);
  } catch {
    return null;
  }
}

/** Dispatch a format's changes in document order, or return the reason it refused. */
function writeChanges(view: EditorView, result: { changes: CommentChange[]; error?: undefined } | { error: string }): string | null {
  if (result.error !== undefined) return result.error;
  const ordered = [...result.changes].sort((a, b) => a.from - b.from);
  return send(view, { changes: ordered, userEvent: "input.comment" }) ? null : DEFAULT_ERROR;
}

/** Keep the thread's pending edit. Returns an error to show, or null. */
export function keepPending(view: EditorView, thread: string): string | null {
  try {
    const author = view.state.facet(commentHost).author();
    if (author === null || view.state.readOnly) return CANT_COMMENT;
    return writeChanges(view, keepSuggestion(view.state.doc.toString(), { thread, author }));
  } catch {
    return DEFAULT_ERROR;
  }
}

/** Undo the thread's pending edit. Returns an error to show, or null. */
export function undoPending(view: EditorView, thread: string): string | null {
  try {
    const author = view.state.facet(commentHost).author();
    if (author === null || view.state.readOnly) return CANT_COMMENT;
    return writeChanges(view, appendEvent(view.state.doc.toString(), { thread, kind: "undid", author }));
  } catch {
    return DEFAULT_ERROR;
  }
}

/**
 * How a thread's Tex message should end, for the popover: Keep and Undo
 * buttons when it carries the pending edit, "Kept" or "Undone" once answered,
 * nothing otherwise. `index` is the event's place in `thread.events`.
 *
 * The suggestion a Tex answer carried is the first suggestion after it with no
 * other Tex answer in between. A newer suggestion after that one supersedes
 * it, so its own answer shows nothing.
 */
export function texMessageState(thread: CommentThread, index: number): "decide" | "kept" | "undone" | null {
  const message = thread.events[index];
  if (message === undefined || message.kind !== "comment" || message.author !== TEX_AUTHOR) return null;
  let suggestion = -1;
  for (let i = index + 1; i < thread.events.length; i += 1) {
    const event = thread.events[i]!;
    if (event.kind === "comment" && event.author === TEX_AUTHOR) return null;
    if (event.kind === "suggestion") {
      suggestion = i;
      break;
    }
  }
  if (suggestion < 0) return null;
  if (thread.pending?.index === suggestion) return "decide";
  for (let i = suggestion + 1; i < thread.events.length; i += 1) {
    const event = thread.events[i]!;
    if (event.kind === "suggestion") return null;
    if (event.kind === "kept") return "kept";
    if (event.kind === "undid") return "undone";
  }
  return null;
}

const EMPTY_RUNS: RunMap = new Map();

/** The pending edit's decorations, following the runs and the thread's suggestion. */
const pendingField = StateField.define<DecorationSet>({
  create: (state) => pendingDecorations(state, state.field(texRuns, false) ?? EMPTY_RUNS, state.field(peerTexRuns, false)),
  update(value, tr) {
    const runsChanged = tr.startState.field(texRuns, false) !== tr.state.field(texRuns, false);
    const peersChanged = tr.startState.field(peerTexRuns, false) !== tr.state.field(peerTexRuns, false);
    if (!tr.docChanged && !runsChanged && !peersChanged) return value;
    return pendingDecorations(tr.state, tr.state.field(texRuns, false) ?? EMPTY_RUNS, tr.state.field(peerTexRuns, false));
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The runner's state and decorations. Install after `comments(...)`, which
 * provides the thread state the decorations read.
 */
export function texInNote(): Extension {
  return [
    texRuns,
    peerTexRuns,
    pendingField,
    texRelay((state) => state.field(texRuns, false)),
    // A comment sent from the card or the phone's sheet: Tex answers when it is named, or is in the thread already.
    commentSent.of((view, { thread, before, body }) => {
      if (view.state.facet(texInNoteHost) !== null && shouldAskTex(before, body)) startTexRun(view, thread, body);
    }),
  ];
}
