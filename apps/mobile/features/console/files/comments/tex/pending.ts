/**
 * How Tex's pending edit looks in the note: the anchored words struck through,
 * the new words inserted after them, and, while Tex is typing, a caret with
 * its name on it. Drawn as decorations, never as document text, so the words
 * only change when somebody presses Keep (the note is not written until then).
 */

import { Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";
import { commentsParsed } from "../extension";
import type { TexRunLive } from "./runner";
import type { PeerTexRun } from "./peerRuns";

/**
 * The inserted words. `eq` compares the text and the caret, so a pass that
 * changes nothing does not rebuild the DOM under the reader's selection.
 */
class PendingWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly caret: boolean,
    readonly thread: string,
    /** The caret's name: "Tex", or "Tex for Sayo" when the run is somebody else's. */
    readonly who: string = "Tex",
  ) {
    super();
  }

  eq(other: PendingWidget): boolean {
    return other.text === this.text && other.caret === this.caret && other.thread === this.thread && other.who === this.who;
  }

  toDOM(): HTMLElement {
    // textContent, never innerHTML: the words are a model's output.
    const span = document.createElement("span");
    span.className = "cm-tex-ins";
    // The popover reads this to sit under the new words, not on top of them.
    span.dataset.thread = this.thread;
    span.textContent = this.text;
    if (this.caret) {
      const caret = document.createElement("span");
      caret.className = "cm-tex-caret";
      caret.dataset.who = this.who;
      span.append(caret);
    }
    return span;
  }
}

/**
 * The decorations for every thread with a pending suggestion (or a run
 * typing one) whose anchor is in the note. A run that is typing shows its
 * text in place of the pending one, so the note never shows two edits at once.
 */
export function pendingDecorations(
  state: EditorState,
  runs: ReadonlyMap<string, TexRunLive>,
  peers: ReadonlyMap<string, PeerTexRun> = new Map(),
): DecorationSet {
  const parsed = state.field(commentsParsed, false);
  if (parsed === undefined) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const thread of parsed.threads) {
    const anchor = parsed.anchors.get(thread.id);
    if (anchor === undefined) continue;
    const typing = runs.get(thread.id)?.typing ?? null;
    // Somebody else's run in this thread, as the room relays it (`peerRuns.ts`).
    const peer = peers.get(thread.id) ?? null;
    let text: string;
    let caret = false;
    let who = "Tex";
    if (typing !== null) {
      text = typing;
      caret = true;
    } else if (peer !== null) {
      text = peer.text;
      caret = true;
      who = `Tex for ${peer.who}`;
    } else if (thread.pending !== null) {
      text = thread.pending.text;
    } else {
      continue;
    }
    // An empty range has no words to strike; the insertion still shows.
    // Before a peer's run has any new words, only its caret shows: the words are not struck until Tex suggests others.
    const striking = !(peer !== null && typing === null && text === "");
    if (striking && anchor.from < anchor.to) ranges.push(Decoration.mark({ class: "cm-tex-del" }).range(anchor.from, anchor.to));
    ranges.push(Decoration.widget({ widget: new PendingWidget(text, caret, thread.id, who), side: 1 }).range(anchor.to));
  }
  return Decoration.set(ranges, true);
}

export interface TexInNoteColors {
  text: string;
  ground: string;
  ins: string;
  del: string;
  crit: string;
}

/**
 * The CSS for the pending edit and the caret, from the editor's colours.
 * Returned as a string so the caller decides where it is mounted; it is not
 * added to the global stylesheet.
 */
export function texInNoteStyles(colors: TexInNoteColors): string {
  return [
    `.cm-tex-del{background:${colors.del};color:${colors.crit};text-decoration:line-through;border-radius:3px}`,
    `.cm-tex-ins{background:${colors.ins};text-decoration:none;border-radius:3px;white-space:pre-wrap}`,
    `.cm-tex-caret{display:inline-block;position:relative;width:2px;height:1.15em;vertical-align:text-bottom;margin:0 1px;background:${colors.text};animation:cm-tex-blink 1s steps(2) infinite}`,
    `.cm-tex-caret::after{content:attr(data-who);position:absolute;left:-1px;top:-15px;font:600 10px/1 system-ui,sans-serif;color:${colors.ground};padding:2px 4px;border-radius:3px 3px 3px 0;white-space:nowrap;background:inherit}`,
    "@keyframes cm-tex-blink{50%{opacity:.35}}",
  ].join("\n");
}
