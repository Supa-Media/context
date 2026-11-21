/**
 * @jest-environment jsdom
 */

/**
 * The comment box in plain view (Dev2, 2026-11-21, artifact MVahUoUgRPthkPk5NMGzXc):
 * threads stack in a margin beside the note without covering each other or the
 * open one, Tex's step names the words it writes after, your own Tex's caret
 * carries your name, and the box has a microphone where the browser can listen.
 *
 * Sabotage (run once, then restored): `stack` placing each card at its words
 * with no push-down failed the overlap test; dropping `viewerName` from
 * `pending.ts` failed the caret test ("Tex" instead of "Seyi’s Tex").
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { comments } from "../features/console/files/comments/extension";
import { stack } from "../features/console/files/comments/margin";
import { buildCard, stepLabel, type CardActions, type CardModel } from "../features/console/files/comments/popoverDom";
import { startTexRun, texInNote, texRuns } from "../features/console/files/comments/tex/runner";
import { texInNoteHost, type NoteRunEvent, type TexInNoteHost } from "../features/console/files/comments/tex/contract";

describe("the margin's stacking", () => {
  test("cards keep their words' order and never overlap", () => {
    const placed = stack(
      [
        { id: "b", top: 120, height: 60 },
        { id: "a", top: 100, height: 60 },
        { id: "c", top: 400, height: 60 },
      ],
      null,
      36,
    );
    expect(placed.map((one) => one.id)).toEqual(["a", "b", "c"]);
    expect(placed[0]!.top).toBe(100);
    expect(placed[1]!.top).toBeGreaterThanOrEqual(100 + 60);
    expect(placed[2]!.top).toBe(400);
  });

  test("a card that would sit under the open one moves below it, and none rises above the head", () => {
    const placed = stack([{ id: "a", top: 10, height: 50 }, { id: "b", top: 220, height: 50 }], { top: 200, height: 180 }, 36);
    expect(placed[0]!.top).toBe(36);
    expect(placed[1]!.top).toBeGreaterThanOrEqual(380);
  });
});

describe("the open card", () => {
  test("Tex's step names the words it writes after, and keeps the generic words for a long quote", () => {
    expect(stepLabel("Writing after the selected words", "honest")).toBe("Writing after “honest”");
    expect(stepLabel("Adding below the selected words", "x".repeat(60))).toBe("Adding below the selected words");
    expect(stepLabel("", "honest")).toBe("Working");
  });

  test("the comment box has no microphone where the browser cannot listen", () => {
    const model: CardModel = { draft: true, thread: null, prefill: "", viewer: "@seyi", editable: true, tex: true, people: [], run: null, texStates: [], deletable: [] };
    const none = () => null;
    const actions: CardActions = { send: none, close: () => {}, resolve: none, keep: none, undo: none, remove: none };
    const { root } = buildCard(model, actions);
    const mic = root.querySelector<HTMLButtonElement>(".cm-mic");
    expect(mic).not.toBeNull();
    expect(mic!.hidden).toBe(true);
  });
});

describe("your own Tex's caret", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.replaceChildren();
  });

  test("is named for you while it types, as other people's are", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const host: TexInNoteHost = {
      async *run(): AsyncGenerator<NoteRunEvent> {
        yield { type: "edit", replace: "honest morning light" };
        await gate;
        yield { type: "done", runId: "run_c", sources: [] };
      },
      runs: async () => [],
      note: () => ({ workspace: "ws_test", noteId: "note_test", path: "Test.md" }),
      people: () => [],
    };
    const doc = ["# Test", "", "<!--c:h1a2-->honest<!--/c:h1a2-->", "", "```comments", 'h1a2 "honest"', "- 2026-11-21T10:00:00Z @seyi: @Tex write a haiku starting with this word", "```", ""].join("\n");
    const parent = document.createElement("div");
    document.body.append(parent);
    view = new EditorView({ parent, state: EditorState.create({ doc, extensions: [comments({ author: () => "@seyi" }), texInNote(), texInNoteHost.of(host)] }) });
    startTexRun(view, "h1a2", "write a haiku starting with this word");
    const started = Date.now();
    while (view.dom.querySelector(".cm-tex-caret") === null && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(view.dom.querySelector<HTMLElement>(".cm-tex-caret")?.dataset.who).toBe("Seyi’s Tex");
    release();
    while (view.state.field(texRuns).has("h1a2") && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 20));
  });
});
