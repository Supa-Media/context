/**
 * Tex writing for somebody else in this note, and this editor's own runs sent
 * to them.
 *
 * A run happens in the asker's editor and its suggestion reaches the note when
 * it ends. Dev2's mock ("Co-write with Sayo") shows the others watching it as it
 * goes: a caret named "Sayo’s Tex", the new words arriving, Tex's face in the
 * pile. The live room carries that (`t: "tex"` frames, never logged), and this
 * module is both ends of it in the editor:
 *
 *  - `texRelay` watches this editor's runs and sends each one's new words in
 *    caret-sized pieces at an offset, a few times a second, then its end.
 *  - `peerTexRuns` holds the others' runs, set from the room's roster, for
 *    `pendingDecorations` to draw.
 */

import { Facet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

/** Somebody else's run: the thread, the new words so far, and who asked. */
export interface PeerTexRun {
  thread: string;
  text: string;
  who: string;
}

export const setPeerTexRuns = StateEffect.define<PeerTexRun[]>();

/** The others' runs, from the room's roster: never this person's own windows, and only runs that are going. */
export function peerRunsOf(members: readonly { name: string; isYou: boolean; tex?: { thread: string; text: string } | null }[]): PeerTexRun[] {
  return members.flatMap((member) => (member.tex && !member.isYou ? [{ thread: member.tex.thread, text: member.tex.text, who: member.name }] : []));
}

/** The others' runs by thread. A thread with two at once shows the later one. */
export const peerTexRuns = StateField.define<ReadonlyMap<string, PeerTexRun>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (!effect.is(setPeerTexRuns)) continue;
      next = new Map(effect.value.map((run) => [run.thread, run]));
    }
    return next;
  },
});

/** Where this editor's runs go: the live room's sender, or null with no room. */
export type TexRelaySend = (thread: string, state: "run" | "end", offset: number, text: string) => void;
export const texRelaySend = Facet.define<TexRelaySend | null, TexRelaySend | null>({
  combine: (values) => values.find((value) => value !== null) ?? null,
});

/** The longest piece in one frame, in characters: four bytes each at most, well inside the room's 1 KB frame. */
export const TEX_PIECE_CHARS = 150;
/** How often a typing run's new words go out. */
export const TEX_RELAY_MS = 120;

/** What `texRelay` reads off a run: whether it is going, and the words typed so far. */
type RunsOf = (state: EditorState) => ReadonlyMap<string, { typing: string | null }> | undefined;

/**
 * The pieces to send for one run, from the offset already sent to the text
 * typed now. Pure, so the chunking is tested without a socket.
 */
export function relayPieces(sent: number, typed: string): Array<{ offset: number; text: string }> {
  const pieces: Array<{ offset: number; text: string }> = [];
  for (let at = sent; at < typed.length; at += TEX_PIECE_CHARS) pieces.push({ offset: at, text: typed.slice(at, at + TEX_PIECE_CHARS) });
  return pieces;
}

/** Sends this editor's runs to the room. `runsOf` reads the runner's field, which this module does not import. */
export function texRelay(runsOf: RunsOf): Extension {
  return ViewPlugin.fromClass(
    class {
      /** Per thread, how many characters the room has. */
      private sent = new Map<string, number>();
      private timer: ReturnType<typeof setTimeout> | null = null;

      constructor(private readonly view: EditorView) {
        this.flush();
      }

      update(update: ViewUpdate) {
        if (runsOf(update.startState) === runsOf(update.state) && update.startState.facet(texRelaySend) === update.state.facet(texRelaySend)) return;
        this.flush(true);
      }

      destroy() {
        if (this.timer !== null) clearTimeout(this.timer);
        const send = this.view.state.facet(texRelaySend);
        if (send !== null) for (const thread of this.sent.keys()) send(thread, "end", 0, "");
        this.sent.clear();
      }

      /** Starts and ends go out at once; new words wait for the next tick, so a run sends a few frames a second. */
      private flush(soon = false) {
        const send = this.view.state.facet(texRelaySend);
        const runs = runsOf(this.view.state) ?? new Map();
        if (send === null) {
          this.sent.clear();
          return;
        }
        for (const [thread] of this.sent) {
          if (runs.has(thread)) continue;
          send(thread, "end", 0, "");
          this.sent.delete(thread);
        }
        let behind = false;
        for (const [thread, run] of runs) {
          if (!this.sent.has(thread)) {
            send(thread, "run", 0, "");
            this.sent.set(thread, 0);
          }
          if ((run.typing ?? "").length > (this.sent.get(thread) ?? 0)) behind = true;
        }
        if (!behind) return;
        if (soon) {
          if (this.timer === null) this.timer = setTimeout(() => this.tick(), TEX_RELAY_MS);
          return;
        }
        this.tick();
      }

      private tick() {
        this.timer = null;
        const send = this.view.state.facet(texRelaySend);
        const runs = runsOf(this.view.state) ?? new Map();
        if (send === null) return;
        for (const [thread, run] of runs) {
          const sent = this.sent.get(thread) ?? 0;
          const typed = run.typing ?? "";
          for (const piece of relayPieces(sent, typed)) send(thread, "run", piece.offset, piece.text);
          if (typed.length > sent) this.sent.set(thread, typed.length);
        }
      }
    },
  );
}
