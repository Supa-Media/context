/**
 * How Tex's edit looks in the note while Tex types it: plain words with a
 * caret carrying Tex's name, as if Tex were typing in the note. An addition
 * appears after the highlighted words, outside the highlight; a rewrite takes
 * the highlighted words' place. Drawn as decorations: the note is written once,
 * when the run ends (runner.ts).
 *
 * A suggestion written before edits applied directly still draws as it did,
 * old words struck and new ones tinted, until somebody keeps or undoes it.
 */

import { texOf } from "./possessive";
import { Decoration, WidgetType, type DecorationSet } from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";
import { commentHost, commentsParsed } from "../extension";
import { anchorWords, isAddition } from "./edit";
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
    /** The caret's name: "Tex", or "Sayo’s Tex" when the run is somebody else's. */
    readonly who: string = "Tex",
    /** Being typed now: plain text, no tint. */
    readonly live: boolean = false,
  ) {
    super();
  }

  eq(other: PendingWidget): boolean {
    return other.text === this.text && other.caret === this.caret && other.thread === this.thread && other.who === this.who && other.live === this.live;
  }

  toDOM(): HTMLElement {
    // textContent, never innerHTML: the words are a model's output.
    const span = document.createElement("span");
    span.className = this.live ? "cm-tex-ins cm-tex-live" : "cm-tex-ins";
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

/** The viewer's name for their own Tex's caret: the handle, capitalised ("@seyi" is "Seyi"), or null. */
function viewerName(state: EditorState): string | null {
  const handle = state.facet(commentHost).author();
  const name = handle?.replace(/^@/, "").trim() ?? "";
  return name === "" ? null : name.charAt(0).toUpperCase() + name.slice(1);
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
  const self = viewerName(state);
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
      // Your own run's caret carries your name too, "Seyi’s Tex", as the people beside you see it (Dev2, 2026-11-21).
      if (self !== null) who = texOf(self);
    } else if (peer !== null) {
      text = peer.text;
      caret = true;
      who = texOf(peer.who);
    } else if (thread.pending !== null) {
      text = thread.pending.text;
    } else {
      continue;
    }
    if (caret) {
      // Typing: plain words where they will land, with Tex's caret.
      const words = anchorWords(state, anchor);
      if (isAddition(words, text)) {
        const tail = text.length > words.length ? text.slice(words.length) : "";
        ranges.push(Decoration.widget({ widget: new PendingWidget(tail, true, thread.id, who, true), side: 1 }).range(anchor.closeEnd));
      } else {
        ranges.push(Decoration.replace({ widget: new PendingWidget(text, true, thread.id, who, true) }).range(anchor.from, anchor.to));
      }
      continue;
    }
    // An old suggestion: an addition after the words keeps them, so only the new part is drawn and nothing is struck.
    const words = state.sliceDoc(anchor.from, anchor.to);
    const adding = words !== "" && (text.startsWith(words) || words.startsWith(text));
    if (adding) text = text.length > words.length ? text.slice(words.length) : "";
    if (!adding && anchor.from < anchor.to) ranges.push(Decoration.mark({ class: "cm-tex-del" }).range(anchor.from, anchor.to));
    ranges.push(Decoration.widget({ widget: new PendingWidget(text, false, thread.id, who), side: 1 }).range(anchor.to));
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
    ".cm-tex-ins.cm-tex-live{background:none;border-radius:0}",
    `.cm-tex-caret{display:inline-block;position:relative;width:2px;height:1.15em;vertical-align:text-bottom;margin:0 1px;background:${colors.text};animation:cm-tex-blink 1s steps(2) infinite}`,
    `.cm-tex-caret::after{content:attr(data-who);position:absolute;left:-1px;top:-15px;font:600 10px/1 system-ui,sans-serif;color:${colors.ground};padding:2px 4px;border-radius:3px 3px 3px 0;white-space:nowrap;background:inherit}`,
    "@keyframes cm-tex-blink{50%{opacity:.35}}",
  ].join("\n");
}
