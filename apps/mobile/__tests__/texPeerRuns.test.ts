/**
 * @jest-environment jsdom
 *
 * Tex writing for somebody else in the note (Dev2's mock, "Co-write with
 * Sayo"): the room's frames, the roster, the pieces this editor sends, and
 * the "Tex for Sayo" caret the others draw.
 *
 * Sabotage (2026-11-21): dropping the offset check in the reducer splices a
 * piece that arrives out of order into the words, and the "out of order"
 * test reddens; dropping "tex" from the room's write gate reddens the
 * read-only check in apps/mcp/test/presence/peerSyncAndAgentWrites.test.mjs.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { comments } from "../features/console/files/comments/extension";
import { startTexRun, texInNote } from "../features/console/files/comments/tex/runner";
import { texInNoteHost, type TexInNoteHost } from "../features/console/files/comments/tex/contract";
import {
  peerRunsOf,
  relayPieces,
  setPeerTexRuns,
  TEX_PIECE_CHARS,
  texRelaySend,
} from "../features/console/files/comments/tex/peerRuns";
import { decodeServerFrame, texFrame, type PresenceMember } from "../features/console/presence/protocol";
import { initialPresenceState, presenceReducer, type PresenceState } from "../features/console/presence/session";

const NOTE = [
  "- <!--c:k7f2-->18 confirmed<!--/c:k7f2--> so far",
  "",
  "```comments",
  'k7f2 "18 confirmed"',
  "- 2026-11-19T10:01:00Z @sayo: @Tex update the count",
  "```",
  "",
].join("\n");

function sayo(extra: Partial<PresenceMember> = {}): PresenceMember {
  return { id: "m-sayo", name: "Sayo", color: null, anchor: null, head: null, canWrite: true, isAgent: false, isYou: false, ...extra };
}

function roomWith(member: PresenceMember): PresenceState {
  return { ...initialPresenceState, phase: "live", notePath: "Party.md", you: "m-me", members: [member] } as PresenceState;
}

function texFrom(id: string, thread: string, state: "run" | "end", offset: number, text: string) {
  return decodeServerFrame(JSON.stringify({ t: "tex", id, th: thread, s: state, o: offset, x: text }))!;
}

const apply = (state: PresenceState, frame: ReturnType<typeof texFrom>) => presenceReducer(state, { type: "frame", notePath: state.notePath ?? "", frame } as never);

let views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  document.body.replaceChildren();
});

const hostSlot = new Compartment();

function mount(send: ((...args: unknown[]) => void) | null = null): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: NOTE,
      extensions: [comments({ author: () => "@seyi" }), texInNote(), texRelaySend.of(send as never), hostSlot.of(texInNoteHost.of(null))],
    }),
  });
  views.push(view);
  return view;
}

describe("the room's Tex frames", () => {
  test("a frame is the shape the room relays, and a bad one is dropped", () => {
    expect(JSON.parse(texFrame("k7f2", "run", 3, "abc"))).toEqual({ t: "tex", th: "k7f2", s: "run", o: 3, x: "abc" });
    expect(texFrom("m-sayo", "k7f2", "run", 0, "20")).toEqual({ t: "tex", id: "m-sayo", thread: "k7f2", state: "run", offset: 0, text: "20" });
    expect(decodeServerFrame(JSON.stringify({ t: "tex", id: "m", th: "BAD!", s: "run", o: 0, x: "" }))).toBeNull();
    expect(decodeServerFrame(JSON.stringify({ t: "tex", id: "m", th: "k7f2", s: "run", o: -1, x: "" }))).toBeNull();
  });

  test("pieces build up the peer's words, and the end takes them down", () => {
    let state = roomWith(sayo());
    state = apply(state, texFrom("m-sayo", "k7f2", "run", 0, ""));
    expect(state.members[0]!.tex).toEqual({ thread: "k7f2", text: "" });
    state = apply(state, texFrom("m-sayo", "k7f2", "run", 0, "20 conf"));
    state = apply(state, texFrom("m-sayo", "k7f2", "run", 7, "irmed"));
    expect(state.members[0]!.tex).toEqual({ thread: "k7f2", text: "20 confirmed" });
    state = apply(state, texFrom("m-sayo", "k7f2", "end", 0, ""));
    expect(state.members[0]!.tex).toBeNull();
  });

  test("a piece that does not follow on is dropped rather than spliced in out of order", () => {
    let state = roomWith(sayo());
    state = apply(state, texFrom("m-sayo", "k7f2", "run", 0, "20"));
    const after = apply(state, texFrom("m-sayo", "k7f2", "run", 9, "zzz"));
    expect(after.members[0]!.tex).toEqual({ thread: "k7f2", text: "20" });
  });

  test("only other people's runs are drawn, never this person's own windows", () => {
    expect(peerRunsOf([sayo({ tex: { thread: "k7f2", text: "20" } }), sayo({ id: "me2", isYou: true, tex: { thread: "k7f2", text: "x" } }), sayo({ id: "m3" })])).toEqual([
      { thread: "k7f2", text: "20", who: "Sayo" },
    ]);
  });
});

describe("the pieces this editor sends", () => {
  test("new words go in pieces at their offsets, each small enough for one frame", () => {
    const typed = "x".repeat(TEX_PIECE_CHARS * 2 + 5);
    expect(relayPieces(0, typed).map((piece) => [piece.offset, piece.text.length])).toEqual([
      [0, TEX_PIECE_CHARS],
      [TEX_PIECE_CHARS, TEX_PIECE_CHARS],
      [TEX_PIECE_CHARS * 2, 5],
    ]);
    expect(relayPieces(4, "abcd")).toEqual([]);
    expect(new TextEncoder().encode(texFrame("k7f2", "run", 99999, "😀".repeat(TEX_PIECE_CHARS))).length).toBeLessThan(1024);
  });

  test("a run going here is told to the room: start, words, end", async () => {
    const sent: unknown[][] = [];
    const view = mount((...args) => sent.push(args));
    const host: TexInNoteHost = {
      async *run() {
        yield { type: "step", id: "1", label: "Editing", state: "running" };
        yield { type: "edit", replace: "20 confirmed (18 + Sayo's 2)" };
        yield { type: "answer", text: "Changed it." };
        yield { type: "done", runId: "r1", sources: [] };
      },
      runs: async () => [],
      note: () => ({ workspace: "w", noteId: "", path: "Party.md" }),
      people: () => [],
    };
    view.dispatch({ effects: hostSlot.reconfigure(texInNoteHost.of(host)) });
    startTexRun(view, "k7f2", "update the count");
    const start = Date.now();
    while (!sent.some((args) => args[1] === "end") && Date.now() - start < 4000) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent[0]).toEqual(["k7f2", "run", 0, ""]);
    const words = sent.filter((args) => args[1] === "run").map((args) => args[3] as string).join("");
    expect("20 confirmed (18 + Sayo's 2)".startsWith(words)).toBe(true);
    expect(sent.at(-1)).toEqual(["k7f2", "end", 0, ""]);
  });
});

describe("what the others see", () => {
  test("a peer's run draws its words with a caret named for whom Tex is writing", () => {
    const view = mount();
    view.dispatch({ effects: setPeerTexRuns.of([{ thread: "k7f2", text: "20 confirmed", who: "Sayo" }]) });
    const ins = view.contentDOM.querySelector(".cm-tex-ins") as HTMLElement;
    expect(ins.textContent).toBe("20 confirmed");
    expect((ins.querySelector(".cm-tex-caret") as HTMLElement).dataset.who).toBe("Tex for Sayo");
    expect(view.contentDOM.querySelector(".cm-tex-del")?.textContent).toBe("18 confirmed");
  });

  test("before any new words, only the caret shows and nothing is struck", () => {
    const view = mount();
    view.dispatch({ effects: setPeerTexRuns.of([{ thread: "k7f2", text: "", who: "Sayo" }]) });
    expect(view.contentDOM.querySelector(".cm-tex-caret")).not.toBeNull();
    expect(view.contentDOM.querySelector(".cm-tex-del")).toBeNull();
  });
});
