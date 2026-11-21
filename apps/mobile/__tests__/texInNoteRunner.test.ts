/**
 * @jest-environment jsdom
 */

/**
 * Tex inside a note (`files/comments/tex/runner.ts`): which messages go to
 * Tex, what a run is told, what it writes into the thread and the note, and
 * how Keep and Undo settle a suggestion written before edits applied directly.
 *
 * Sabotage (run once, then restored): `tellNote` was made to write the edit
 * at `anchor.to` (inside the highlight) instead of `anchor.closeEnd`. Result:
 * the addition and undo tests failed on the note's text. Dropping the
 * history annotations failed the undo test.
 *
 * Sabotage (run once, then restored): `keepPending` was changed to write only
 * the `kept` line and skip the replace of the anchored words. Result: 1 of 25
 * tests failed ("Keep replaces the anchored words ..."), the other 24 passed.
 * The check that catches it is the one that reads the note's words after Keep.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { EditorState, type Extension } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { parseComments, type CommentThread } from "@context/shared/src/comments.cjs";
import { comments, sendComment } from "../features/console/files/comments/extension";
import {
  keepPending,
  mentionsTex,
  shouldAskTex,
  startTexRun,
  stopTexRun,
  texInNote,
  texInNoteStyles,
  texMessageState,
  texRuns,
  undoPending,
} from "../features/console/files/comments/tex/runner";
import { texInNoteHost, type NoteRunEvent, type NoteRunRequest, type TexInNoteHost } from "../features/console/files/comments/tex/contract";

const AT = "2026-11-19T10:02:00Z";

const NOTE = [
  "# Party",
  "",
  "Pick up the <!--c:k7f2-->cake<!--/c:k7f2--> on Saturday.",
  "",
  "```comments",
  'k7f2 "cake"',
  "- 2026-11-19T10:00:00Z @sayo: who's picking up the cake?",
  "- 2026-11-19T10:01:00Z @dev2: @Tex who's picking up the cake?",
  "```",
  "",
].join("\n");

/** The same note with Tex's answer and suggestion already in the thread. */
const WITH_SUGGESTION = NOTE.replace(
  "```\n",
  [`- ${AT} Tex: Sayo said he would.`, `- ${AT} Tex suggests: "cake, Saturday at 5"`, "```", ""].join("\n"),
);

type Item = NoteRunEvent | { wait: Promise<void> };

/** A host whose run yields the scripted items, recording what it was asked and told. */
function harness(plan: Item[] | "throw") {
  const requests: NoteRunRequest[] = [];
  const running: boolean[] = [];
  const done: string[] = [];
  const host: TexInNoteHost = {
    async *run(request, signal) {
      requests.push(request);
      if (plan === "throw") throw new Error("gateway fell over");
      for (const item of plan) {
        if (signal.aborted) return;
        if ("wait" in item) await item.wait;
        else yield item;
      }
    },
    runs: async () => [],
    note: () => ({ workspace: "ws_test", noteId: "note_test", path: "Party.md" }),
    people: () => [],
    onRunDone: (runId) => done.push(runId),
    onRunning: (on) => running.push(on),
  };
  return { host, requests, running, done };
}

let views: EditorView[] = [];
afterEach(() => {
  for (const view of views) view.destroy();
  views = [];
  document.body.replaceChildren();
});

function mount(doc: string, host: TexInNoteHost | null, author: string | null = "@dev2", more: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [comments({ author: () => author }), texInNote(), texInNoteHost.of(host), ...more],
    }),
  });
  views.push(view);
  return view;
}

function threadOf(doc: string): CommentThread {
  return parseComments(doc).threads[0]!;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for the run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const runs = (view: EditorView) => view.state.field(texRuns);

describe("which messages go to Tex", () => {
  test("a message that names @Tex goes to Tex, in any case", () => {
    expect(mentionsTex("@Tex who's picking up?")).toBe(true);
    expect(mentionsTex("hey @tex check this")).toBe(true);
    expect(shouldAskTex(null, "@Tex hi")).toBe(true);
  });

  test("an address that merely contains tex does not name Tex", () => {
    expect(mentionsTex("mail me at sam@tex.com")).toBe(false);
    expect(shouldAskTex(null, "mail me at sam@tex.com")).toBe(false);
  });

  test("once Tex is in the thread, a message that names nobody goes to Tex", () => {
    const thread = threadOf(WITH_SUGGESTION);
    expect(shouldAskTex(thread, "make it 6pm")).toBe(true);
  });

  test("a message that names someone else stays with them even when Tex is in the thread", () => {
    const thread = threadOf(WITH_SUGGESTION);
    expect(shouldAskTex(thread, "@sayo can you take this?")).toBe(false);
  });

  test("a thread Tex has not joined takes a plain message as a plain message", () => {
    expect(shouldAskTex(threadOf(NOTE), "sounds good")).toBe(false);
    expect(shouldAskTex(null, "sounds good")).toBe(false);
  });
});

describe("what a pending edit draws", () => {
  // Dev2, 2026-11-21: an outline added under a premise must read as an addition, not the premise struck and retyped.
  test("an addition after the words draws only the new words, and strikes nothing", () => {
    const view = mount(WITH_SUGGESTION.replace('Tex suggests: "cake, Saturday at 5"', 'Tex suggests: "cake\\n\\n1. Order it\\n2. Pick it up"'), null);
    expect(view.dom.querySelector(".cm-tex-del")).toBeNull();
    expect(view.dom.querySelector(".cm-tex-ins")?.textContent).toBe("\n\n1. Order it\n2. Pick it up");
  });

  test("a change to the words strikes them and draws the new words whole", () => {
    const view = mount(WITH_SUGGESTION.replace('Tex suggests: "cake, Saturday at 5"', 'Tex suggests: "the birthday cake"'), null);
    expect(view.dom.querySelector(".cm-tex-del")?.textContent).toBe("cake");
    expect(view.dom.querySelector(".cm-tex-ins")?.textContent).toBe("the birthday cake");
  });
});

describe("a message sent from the card or the phone's sheet", () => {
  // Both send through sendComment; the sheet once wrote the reply and never told Tex (Dev2, 2026-11-21: "add it to the note" got nothing).
  test("a follow-up in a thread Tex is in, naming nobody, starts a run", async () => {
    const { host, requests } = harness([{ type: "done", runId: "run_s1", sources: [] }]);
    const view = mount(WITH_SUGGESTION, host);
    expect(sendComment(view, "k7f2", "add it to the note")).toBeNull();
    await waitFor(() => requests.length === 1);
    expect(requests[0]!.ask).toBe("add it to the note");
  });

  test("a plain reply in a thread Tex is not in starts nothing", async () => {
    const { host, requests } = harness([{ type: "done", runId: "run_s2", sources: [] }]);
    const view = mount(NOTE, host);
    expect(sendComment(view, "k7f2", "sounds good")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(requests).toEqual([]);
  });
});

describe("a run", () => {
  test("writes Tex's addition straight into the note after the highlight, and its answer into the thread", async () => {
    const { host, running, done } = harness([
      { type: "step", id: "s1", label: "Reading the note", state: "running" },
      { type: "step", id: "s1", label: "Reading the note", state: "done", ms: 40 },
      { type: "answer", text: "Sayo said he would pick it up on Saturday." },
      { type: "edit", replace: "cake, Saturday at 5" },
      { type: "done", runId: "run_1", sources: [] },
    ]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "who's picking up the cake?");
    await waitFor(() => !runs(view).has("k7f2"));

    const doc = view.state.doc.toString();
    expect(doc).toMatch(/- \S+ Tex: Sayo said he would pick it up on Saturday\./);
    // Nothing to accept: no suggestion line, no pending edit, no Keep or Undo.
    expect(doc).not.toContain("Tex suggests");
    expect(threadOf(doc).pending).toBeNull();
    // The added words are the note's own text, after the comment's close marker, not inside the highlight.
    expect(doc).toContain("<!--c:k7f2-->cake<!--/c:k7f2-->, Saturday at 5 on Saturday.");
    expect(view.dom.querySelector(".cm-tex-ins")).toBeNull();
    expect(view.dom.querySelector(".cm-tex-del")).toBeNull();
    expect(running).toEqual([true, false]);
    expect(done).toEqual(["run_1"]);
  });

  test("a rewrite takes the highlighted words out and writes the new ones after the thread, unhighlighted", async () => {
    const { host } = harness([{ type: "edit", replace: "birthday cake" }, { type: "done", runId: "run_r", sources: [] }]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "say which cake");
    await waitFor(() => !runs(view).has("k7f2"));
    const doc = view.state.doc.toString();
    // The thread stays, as a point where the words were; the new words are the note's own text.
    expect(doc).toContain("Pick up the <!--c:k7f2--><!--/c:k7f2-->birthday cake on Saturday.");
    expect(parseComments(doc).threads.map((t) => t.id)).toEqual(["k7f2"]);
    expect(view.dom.querySelector(".cm-cmt-hl")?.textContent ?? "").not.toContain("birthday");
    expect(doc).not.toContain("Tex suggests");
  });

  test("a rewrite keeps another thread's markers inside the words", async () => {
    const nested = NOTE.replace("<!--c:k7f2-->cake<!--/c:k7f2-->", "<!--c:k7f2-->the <!--c:b2b2-->cake<!--/c:b2b2--><!--/c:k7f2-->").replace(
      "```\n",
      ["", 'b2b2 "cake"', "- 2026-11-19T10:00:30Z @sayo: which one?", "```", ""].join("\n"),
    );
    const { host } = harness([{ type: "edit", replace: "a birthday cake" }, { type: "done", runId: "run_n", sources: [] }]);
    const view = mount(nested, host);
    startTexRun(view, "k7f2", "say which cake");
    await waitFor(() => !runs(view).has("k7f2"));
    const doc = view.state.doc.toString();
    expect(doc).toContain("<!--c:k7f2--><!--c:b2b2--><!--/c:b2b2--><!--/c:k7f2-->a birthday cake");
    expect(parseComments(doc).threads.map((t) => t.id).sort()).toEqual(["b2b2", "k7f2"]);
  });

  test("markers and a comments block in Tex's edit are never written into the note", async () => {
    const copied = "<!--c:k7f2-->cake<!--/c:k7f2-->, Saturday at 5\n\n```comments\nk7f2 \"cake\"\n- 2026-11-19T10:00:00Z @sayo: who?\n```";
    const { host } = harness([{ type: "edit", replace: copied }, { type: "done", runId: "run_m", sources: [] }]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "add the time");
    await waitFor(() => !runs(view).has("k7f2"));
    const doc = view.state.doc.toString();
    expect(doc).toContain("<!--c:k7f2-->cake<!--/c:k7f2-->, Saturday at 5");
    expect(doc.match(/<!--c:k7f2-->/g)).toHaveLength(1);
    expect(doc.match(/```comments/g)).toHaveLength(1);
  });

  test("one undo takes back Tex's edit and its line together, and the thread stays whole", async () => {
    const { host } = harness([{ type: "edit", replace: "cake, Saturday at 5" }, { type: "done", runId: "run_u", sources: [] }]);
    const view = mount(NOTE, host, "@dev2", [history()]);
    startTexRun(view, "k7f2", "add the time");
    await waitFor(() => !runs(view).has("k7f2"));
    expect(view.state.doc.toString()).toContain("cake<!--/c:k7f2-->, Saturday at 5 on");
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test("an answer alone is one undo step too, and undo never leaves Tex's line without its thread", async () => {
    const { host } = harness([{ type: "answer", text: "Sayo is." }, { type: "done", runId: "run_ua", sources: [] }]);
    const view = mount(NOTE, host, "@dev2", [history()]);
    startTexRun(view, "k7f2", "who?");
    await waitFor(() => !runs(view).has("k7f2"));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  test("with an edit but no answer, the thread says Done, and asks nothing", async () => {
    const { host } = harness([{ type: "edit", replace: "cake, Saturday at 5" }, { type: "done", runId: "run_2", sources: [] }]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "add the time");
    await waitFor(() => !runs(view).has("k7f2"));
    const doc = view.state.doc.toString();
    expect(doc).toMatch(/- \S+ Tex: Done\.\n/);
    expect(doc).not.toMatch(/Keep or undo/);
  });

  test("an answer with no edit writes only the answer", async () => {
    const { host } = harness([{ type: "answer", text: "Sayo is." }, { type: "done", runId: "run_a", sources: [] }]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "who?");
    await waitFor(() => !runs(view).has("k7f2"));
    const doc = view.state.doc.toString();
    expect(doc).toMatch(/- \S+ Tex: Sayo is\./);
    expect(doc).toContain("Pick up the <!--c:k7f2-->cake<!--/c:k7f2--> on Saturday.");
  });

  test("while Tex types, the new words show in the note with a caret, and the note is not written yet", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { host } = harness([{ type: "edit", replace: "cake, Saturday at 5" }, { wait: gate }, { type: "done", runId: "run_3", sources: [] }]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "add the time");
    await waitFor(() => runs(view).get("k7f2")?.typing === "cake, Saturday at 5");
    expect(view.dom.querySelector(".cm-tex-caret")).not.toBeNull();
    // Plain words where they will land, outside the highlight, with nothing tinted or struck.
    const typed = view.dom.querySelector(".cm-tex-ins");
    expect(typed?.textContent).toBe(", Saturday at 5");
    expect(typed?.classList.contains("cm-tex-live")).toBe(true);
    expect(view.dom.querySelector(".cm-tex-del")).toBeNull();
    expect(view.state.doc.toString()).toBe(NOTE);
    release();
    await waitFor(() => !runs(view).has("k7f2"));
    expect(view.dom.querySelector(".cm-tex-caret")).toBeNull();
  });

  test("the request carries the words, their surroundings without markers, the history and the pending edit", async () => {
    const { host, requests } = harness([{ type: "done", runId: "run_4", sources: [] }]);
    const view = mount(NOTE, host);
    startTexRun(view, "k7f2", "@Tex who's picking up the cake?");
    await waitFor(() => !runs(view).has("k7f2"));
    const [request] = requests;
    expect(request).toMatchObject({ workspace: "ws_test", noteId: "note_test", path: "Party.md", thread: "k7f2", pending: null });
    expect(request!.anchor.text).toBe("cake");
    expect(request!.anchor.before).toBe("# Party\n\nPick up the ");
    // The comments block is conversation about the note, not the note: it never rides along as context.
    expect(request!.anchor.after).toBe(" on Saturday.\n");
    expect(request!.ask).toBe("who's picking up the cake?");
    expect(request!.history).toEqual([
      { who: "@sayo", body: "who's picking up the cake?" },
      { who: "@dev2", body: "@Tex who's picking up the cake?" },
    ]);
    expect(JSON.stringify(request)).not.toContain("<!--");
  });

  test("a follow-up on a pending suggestion sends that suggestion so the run can revise it", async () => {
    const { host, requests } = harness([{ type: "done", runId: "run_5", sources: [] }]);
    const view = mount(WITH_SUGGESTION, host);
    startTexRun(view, "k7f2", "make it 6pm");
    await waitFor(() => !runs(view).has("k7f2"));
    expect(requests[0]!.pending).toBe("cake, Saturday at 5");
  });

  test("an error event leaves the error in the run, writes nothing to the note, and stops the typing", async () => {
    const { host, running } = harness([
      { type: "edit", replace: "cake, Saturday at 5" },
      { type: "error", message: "Tex is offline." },
    ]);
    const view = mount(NOTE, host);
    const before = view.state.doc.toString();
    startTexRun(view, "k7f2", "add the time");
    await waitFor(() => runs(view).get("k7f2")?.error != null);
    expect(runs(view).get("k7f2")).toMatchObject({ error: "Tex is offline.", typing: null });
    expect(view.state.doc.toString()).toBe(before);
    expect(running).toEqual([true, false]);
  });

  test("a stream that throws becomes the standard sentence, and writes nothing", async () => {
    const { host } = harness("throw");
    const view = mount(NOTE, host);
    const before = view.state.doc.toString();
    startTexRun(view, "k7f2", "hi");
    await waitFor(() => runs(view).get("k7f2")?.error != null);
    expect(runs(view).get("k7f2")?.error).toBe("Tex couldn't finish this. Try again.");
    expect(view.state.doc.toString()).toBe(before);
  });

  test("stopping a run removes it and writes nothing", async () => {
    const { host, running } = harness([{ wait: new Promise<void>(() => {}) }, { type: "answer", text: "late" }]);
    const view = mount(NOTE, host);
    const before = view.state.doc.toString();
    startTexRun(view, "k7f2", "hi");
    expect(runs(view).has("k7f2")).toBe(true);
    stopTexRun(view, "k7f2");
    expect(runs(view).has("k7f2")).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
    expect(running).toEqual([true, false]);
  });

  test("without a host, starting a run does nothing", () => {
    const view = mount(NOTE, null);
    const before = view.state.doc.toString();
    startTexRun(view, "k7f2", "@Tex hi");
    expect(view.state.doc.toString()).toBe(before);
    expect(runs(view).size).toBe(0);
  });
});

describe("Keep and Undo", () => {
  test("Keep replaces the anchored words with the suggestion and records who kept it", () => {
    const view = mount(WITH_SUGGESTION, harness([]).host);
    expect(keepPending(view, "k7f2")).toBeNull();
    const doc = view.state.doc.toString();
    expect(doc).toContain("<!--c:k7f2-->cake, Saturday at 5<!--/c:k7f2-->");
    expect(doc).toMatch(/- \S+ @dev2 kept/);
    expect(view.dom.querySelector(".cm-tex-del")).toBeNull();
    expect(view.dom.querySelector(".cm-tex-ins")).toBeNull();
  });

  test("Undo records the undo and leaves the words as they were", () => {
    const view = mount(WITH_SUGGESTION, harness([]).host);
    expect(undoPending(view, "k7f2")).toBeNull();
    const doc = view.state.doc.toString();
    expect(doc).toContain("<!--c:k7f2-->cake<!--/c:k7f2-->");
    expect(doc).toMatch(/- \S+ @dev2 undid/);
    expect(threadOf(doc).pending).toBeNull();
  });

  test("a reader who cannot comment is told so, and nothing is written", () => {
    const view = mount(WITH_SUGGESTION, harness([]).host, null);
    const before = view.state.doc.toString();
    expect(keepPending(view, "k7f2")).toBe("This note can't take comments here.");
    expect(undoPending(view, "k7f2")).toBe("This note can't take comments here.");
    expect(view.state.doc.toString()).toBe(before);
  });
});

describe("the Keep, Undo or Kept line under a Tex answer", () => {
  const T1 = `- ${AT} @dev2: @Tex who's picking up?`;
  const TEX = `- ${AT} Tex: Sayo said he would.`;
  const SUG_A = `- ${AT} Tex suggests: "cake, Saturday at 5"`;
  const SUG_B = `- ${AT} Tex suggests: "cake, Saturday at 6"`;
  const KEPT = `- ${AT} @dev2 kept`;
  const UNDID = `- ${AT} @dev2 undid`;
  const FOLLOW = `- ${AT} @dev2: @Tex make it 6`;
  const TEX2 = `- ${AT} Tex: Changed to 6.`;

  function threadFrom(lines: string[]): CommentThread {
    const doc = ["# Party", "", "Pick up the <!--c:k7f2-->cake<!--/c:k7f2-->.", "", "```comments", 'k7f2 "cake"', ...lines, "```", ""].join("\n");
    return threadOf(doc);
  }

  test("a pending suggestion says Keep or Undo", () => {
    const thread = threadFrom([T1, TEX, SUG_A]);
    expect(texMessageState(thread, 1)).toBe("decide");
  });

  test("a kept suggestion says Kept", () => {
    expect(texMessageState(threadFrom([T1, TEX, SUG_A, KEPT]), 1)).toBe("kept");
  });

  test("an undone suggestion says Undone", () => {
    expect(texMessageState(threadFrom([T1, TEX, SUG_A, UNDID]), 1)).toBe("undone");
  });

  test("an answer whose suggestion a newer answer replaced shows nothing, and the newer one decides", () => {
    const thread = threadFrom([T1, TEX, SUG_A, FOLLOW, TEX2, SUG_B]);
    expect(texMessageState(thread, 1)).toBeNull();
    expect(texMessageState(thread, 4)).toBe("decide");
  });

  test("a newer suggestion with no answer between supersedes the older one", () => {
    const thread = threadFrom([TEX, SUG_A, SUG_B]);
    expect(texMessageState(thread, 0)).toBeNull();
  });

  test("a kept answer before a newer one stays Kept, and the newer one is not counted for it", () => {
    const thread = threadFrom([TEX, SUG_A, KEPT, FOLLOW, TEX2, SUG_B]);
    expect(texMessageState(thread, 0)).toBe("kept");
    expect(texMessageState(thread, 4)).toBe("decide");
  });

  test("an event that is not Tex's answer has no state", () => {
    expect(texMessageState(threadFrom([T1, TEX, SUG_A]), 0)).toBeNull();
  });
});

describe("the styles", () => {
  test("the struck words and the inserted words take the colours given, and the caret is named Tex", () => {
    const css = texInNoteStyles({ text: "#111", ground: "#fff", ins: "#0f0", del: "#f00", crit: "#900" });
    expect(css).toContain(".cm-tex-del{background:#f00;color:#900;text-decoration:line-through");
    expect(css).toContain(".cm-tex-ins{background:#0f0");
    expect(css).toContain("background:#111;animation:cm-tex-blink");
    expect(css).toContain("content:attr(data-who)");
  });
});
