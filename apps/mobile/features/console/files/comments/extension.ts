/**
 * Comments in the editor: the anchors drawn as highlights, the markers and the
 * `comments` block kept out of sight, and the commands that add to the log.
 *
 * The file is the source of truth (`packages/shared/src/comments.cjs`), so
 * everything here is a view of the document plus a little UI state — which
 * thread is active, whether a new comment is being written, whether resolved
 * threads are shown. Every action is an ordinary transaction on the document:
 * a new thread is two marker insertions and a block insertion, a reply is one
 * line. That means comments travel through the same collaboration binding,
 * autosave and undo history as typing does, with nothing of their own to keep
 * in sync.
 *
 * ## Why the markers are atomic and the block is a block replacement
 *
 * `<!--c:k7f2-->` is plumbing a person should never place a caret inside:
 * half-deleting one detaches a comment. So the markers are replaced by nothing
 * and registered as atomic ranges, which makes arrows and backspace step over
 * them as one unit. The block at the end is replaced the same way frontmatter
 * is (`livePreview/frontmatter.ts`), but without the reveal-on-caret rule: the
 * margin is where the threads are read and written, and a block of log lines
 * appearing under the note when the caret reaches the end would be the raw
 * form of something the margin already draws.
 *
 * The margin itself is `rail.ts`.
 */

import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { mayDelete } from "./model";
import {
  addThread,
  appendEvent,
  deleteComment,
  parseComments,
  type CommentChange,
  type CommentEvent,
  type CommentThread,
  type CommentsBlock,
  type CommentAnchor,
} from "@context/shared/src/comments.cjs";

/** What the surface around the editor tells it: who is commenting. */
export interface CommentHost {
  /** The `@handle` new comments are signed with, or null when nobody can comment here. */
  author: () => string | null;
  /**
   * Where a visitor goes to be able to reply, or absent where signing in is
   * not the answer (a member who may read but not write). A thread says
   * "Sign in to reply" only when this is there.
   */
  signIn?: () => (() => void) | undefined;
  /**
   * Whether the viewer may delete anyone's comments (a workspace owner), not
   * just their own. Absent means own comments only.
   */
  moderator?: () => boolean;
}

export const commentHost = Facet.define<CommentHost, CommentHost>({
  combine: (values) => values[0] ?? { author: () => null },
});

export interface CommentUi {
  active: string | null;
  /** A comment being written on this range, before it exists in the file. */
  draft: { from: number; to: number } | null;
  showResolved: boolean;
}

export const setActiveThread = StateEffect.define<string | null>();
export const setDraft = StateEffect.define<{ from: number; to: number } | null>();
export const setShowResolved = StateEffect.define<boolean>();

export const commentUi = StateField.define<CommentUi>({
  create: () => ({ active: null, draft: null, showResolved: false }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.draft !== null) {
      const from = tr.changes.mapPos(next.draft.from, 1);
      const to = tr.changes.mapPos(next.draft.to, -1);
      next = { ...next, draft: from < to ? { from, to } : null };
    }
    for (const effect of tr.effects) {
      if (effect.is(setActiveThread)) next = { ...next, active: effect.value };
      if (effect.is(setDraft)) next = { ...next, draft: effect.value, active: effect.value === null ? next.active : null };
      if (effect.is(setShowResolved)) next = { ...next, showResolved: effect.value };
    }
    return next;
  },
});

export interface ParsedComments {
  threads: CommentThread[];
  anchors: Map<string, CommentAnchor>;
  block: CommentsBlock | null;
  /**
   * The `[from, to)` of both markers of every anchor. Only paired markers
   * outside code are hidden: half an anchor left behind by an edit stays
   * visible, which is the honest way to show that something is broken.
   */
  markers: { from: number; to: number }[];
}

function parse(state: EditorState): ParsedComments {
  const { threads, anchors, block } = parseComments(state.doc.toString());
  const markers: { from: number; to: number }[] = [];
  for (const anchor of anchors.values()) {
    markers.push({ from: anchor.openStart, to: anchor.from }, { from: anchor.to, to: anchor.closeEnd });
  }
  return { threads, anchors, block, markers };
}

export const commentsParsed = StateField.define<ParsedComments>({
  create: parse,
  update: (value, tr) => (tr.docChanged ? parse(tr.state) : value),
});

/** The lines the block occupies, plus the blank lines just above it. */
export function hiddenBlockRange(state: EditorState, block: CommentsBlock): { from: number; to: number } {
  const doc = state.doc;
  let first = doc.lineAt(block.start);
  while (first.number > 1) {
    const above = doc.line(first.number - 1);
    if (above.text.trim() !== "") break;
    first = above;
  }
  const last = doc.lineAt(Math.max(block.start, block.end - 1));
  return { from: first.from, to: last.to };
}

const hideMarker = Decoration.replace({});
const hideBlock = Decoration.replace({ block: true });

function build(state: EditorState): { all: DecorationSet; atomic: DecorationSet } {
  const parsed = state.field(commentsParsed);
  const ui = state.field(commentUi);
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const hidden = parsed.block === null ? null : hiddenBlockRange(state, parsed.block);
  const byId = new Map(parsed.threads.map((thread) => [thread.id, thread]));

  for (const [id, anchor] of parsed.anchors) {
    const thread = byId.get(id);
    if (!thread || anchor.from >= anchor.to) continue;
    if (thread.status === "resolved" && !ui.showResolved) continue;
    const classes = ["cm-cmt-hl"];
    if (ui.active === id) classes.push("cm-cmt-hl-active");
    if (thread.status === "resolved") classes.push("cm-cmt-hl-resolved");
    ranges.push(Decoration.mark({ class: classes.join(" "), attributes: { "data-comment": id } }).range(anchor.from, anchor.to));
  }
  if (ui.draft !== null && ui.draft.from < ui.draft.to) {
    ranges.push(Decoration.mark({ class: "cm-cmt-hl cm-cmt-hl-active" }).range(ui.draft.from, ui.draft.to));
  }
  for (const marker of parsed.markers) {
    if (hidden !== null && marker.from >= hidden.from && marker.to <= hidden.to) continue;
    const range = hideMarker.range(marker.from, marker.to);
    ranges.push(range);
    atomic.push(range);
  }
  if (hidden !== null) {
    const range = hideBlock.range(hidden.from, hidden.to);
    ranges.push(range);
    atomic.push(range);
  }
  return { all: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true) };
}

const commentDecorations = StateField.define<{ all: DecorationSet; atomic: DecorationSet }>({
  create: build,
  update(value, tr) {
    const uiChanged = tr.startState.field(commentUi) !== tr.state.field(commentUi);
    return tr.docChanged || uiChanged ? build(tr.state) : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.all),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});

/* -------------------------------------------------------------------------- */
/*                                  commands                                  */
/* -------------------------------------------------------------------------- */

function specFor(changes: readonly CommentChange[], effects: StateEffect<unknown>[]): TransactionSpec {
  // In document order: CodeMirror reads every change against the original
  // text, and equal positions keep the order the format gave them.
  const sorted = [...changes].map((change, index) => ({ change, index })).sort((a, b) => a.change.from - b.change.from || a.index - b.index);
  return { changes: sorted.map(({ change }) => change), effects, userEvent: "input.comment" };
}

/** Whether this editor can take a new comment or a reply at all. */
export function canComment(state: EditorState): boolean {
  return !state.readOnly && state.facet(commentHost).author() !== null;
}

/** Start writing a comment on the selection. False when there is nothing to comment on. */
export function startComment(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  return startCommentOn(view, { from, to });
}

/**
 * Start writing a comment on `range`, which a touch chip remembers from the
 * moment it was pressed: on a phone the tap that reaches the chip can move or
 * collapse the selection before the click arrives.
 */
export function startCommentOn(view: EditorView, { from, to }: { from: number; to: number }): boolean {
  if (!canComment(view.state)) return false;
  const length = view.state.doc.length;
  if (from < 0 || to > length || from >= to) return false;
  const text = view.state.sliceDoc(from, to);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if (to - trail <= from + lead) return false;
  view.dispatch({ effects: setDraft.of({ from: from + lead, to: to - trail }) });
  return true;
}

/**
 * The selection a Comment chip would offer to comment on, or null when there
 * is no chip: nobody can comment here, nothing is selected, the selection is
 * only whitespace or inside the comments block, or a comment is already being
 * written. The margin's chip and the phone's floating chip both ask this.
 */
export function commentableSelection(state: EditorState): { from: number; to: number } | null {
  if (!canComment(state) || state.field(commentUi).draft !== null) return null;
  const { from, to } = state.selection.main;
  if (from === to || state.sliceDoc(from, to).trim() === "") return null;
  const block = state.field(commentsParsed).block;
  if (block !== null && to > block.start) return null;
  return { from, to };
}

/** The transaction that turns the draft into a thread, or the reason it cannot. */
export function draftTransaction(state: EditorState, body: string): TransactionSpec | { error: string } {
  const ui = state.field(commentUi);
  const author = state.facet(commentHost).author();
  if (ui.draft === null || author === null || state.readOnly) return { error: "This note can't take comments here." };
  const result = addThread(state.doc.toString(), { from: ui.draft.from, to: ui.draft.to, author, body });
  if (result.error !== undefined) return { error: result.error };
  // The caret goes to the end of the words just commented on, past the closing
  // marker, so the selection that asked for the comment does not linger and
  // offer to comment on the same words again.
  const after = ui.draft.to + result.changes.filter((c) => c.from <= ui.draft!.to).reduce((sum, c) => sum + c.insert.length, 0);
  return { ...specFor(result.changes, [setDraft.of(null), setActiveThread.of(result.id)]), selection: { anchor: after } };
}

/** The transaction that replies to, resolves or reopens a thread, or the reason it cannot. */
export function threadTransaction(
  state: EditorState,
  thread: string,
  kind: "comment" | "resolved" | "reopened",
  body?: string,
): TransactionSpec | { error: string } {
  const author = state.facet(commentHost).author();
  if (author === null || state.readOnly) return { error: "This note can't take comments here." };
  const result = appendEvent(state.doc.toString(), { thread, kind, author, body });
  if (result.error !== undefined) return { error: result.error };
  return specFor(result.changes, kind === "resolved" ? [setActiveThread.of(null)] : []);
}

/** Whether this viewer may delete `event`, the thread's comment it was given as. */
export function canDeleteComment(state: EditorState, event: CommentEvent): boolean {
  if (!canComment(state)) return false;
  const host = state.facet(commentHost);
  return mayDelete(event.author, host.author(), host.moderator?.() ?? false);
}

/**
 * The transaction that deletes a thread's `index`th comment (0 deletes the
 * thread), or the reason it cannot. The comment is named by what the viewer
 * saw, so one that changed under them is refused rather than guessed at.
 */
export function deleteTransaction(state: EditorState, thread: string, index: number, seen: CommentEvent): TransactionSpec | { error: string } {
  if (!canDeleteComment(state, seen)) return { error: "You can only delete your own comments." };
  const result = deleteComment(state.doc.toString(), { thread, index, expect: { at: seen.at, author: seen.author } });
  if (result.error !== undefined) return { error: result.error };
  const ui = state.field(commentUi);
  return specFor(result.changes, index === 0 && ui.active === thread ? [setActiveThread.of(null)] : []);
}

function run(view: EditorView, spec: TransactionSpec | { error: string }): string | null {
  if ("error" in spec && typeof spec.error === "string") return spec.error;
  view.dispatch(spec as TransactionSpec);
  return null;
}

/** Turn the draft into a thread. Returns an error to show, or null when it was added. */
export function submitDraft(view: EditorView, body: string): string | null {
  return run(view, draftTransaction(view.state, body));
}

/** Reply to, resolve or reopen a thread. Returns an error to show, or null. */
export function addToThread(view: EditorView, thread: string, kind: "comment" | "resolved" | "reopened", body?: string): string | null {
  return run(view, threadTransaction(view.state, thread, kind, body));
}

/** Delete a comment, or its whole thread when it is the first. Returns an error to show, or null. */
export function removeFromThread(view: EditorView, thread: string, index: number, seen: CommentEvent): string | null {
  return run(view, deleteTransaction(view.state, thread, index, seen));
}

const clickHighlight = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target instanceof Element ? event.target.closest("[data-comment]") : null;
    const id = target?.getAttribute("data-comment") ?? null;
    if (view.state.field(commentUi).active !== id) view.dispatch({ effects: setActiveThread.of(id) });
    return false;
  },
});

/**
 * The editor's comments, for a surface that knows who is commenting.
 *
 * ⌘⌥M (Ctrl-Alt-M elsewhere) starts a comment on the selection, which is the
 * chord Google Docs uses; the margin's Comment button and the right-click menu
 * do the same thing.
 */
export function comments(host: CommentHost): Extension {
  return [
    commentHost.of(host),
    commentUi,
    commentsParsed,
    Prec.high(commentDecorations),
    clickHighlight,
    keymap.of([{ key: "Mod-Alt-m", run: startComment }]),
  ];
}
