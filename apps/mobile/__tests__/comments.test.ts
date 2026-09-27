/**
 * Comments in the console: the margin's pure rules (`files/comments/model.ts`)
 * and the editor's view of the file (`files/comments/extension.ts`).
 *
 * The format and the gateway's half are covered in
 * `apps/mcp/test/comments.test.mjs`. What matters here is that the editor
 * never changes a note except by the insertions a comment is made of, and that
 * the plumbing (markers, the block) is out of sight and out of the caret's way.
 */

import { describe as group, expect, test } from "@jest/globals";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { parseComments } from "@context/shared/src/comments.cjs";
import {
  commentUi,
  commentsParsed,
  comments,
  draftTransaction,
  hiddenBlockRange,
  threadTransaction,
  setDraft,
  setShowResolved,
} from "../features/console/files/comments/extension";
import { initialsFor, isPerson, stackCards, visibleThreads, whenLabel } from "../features/console/files/comments/model";

const NOTE = [
  "# <!--c:k7f2-->free, you cheapo<!--/c:k7f2--> :annoyed:",
  "",
  "Premium is like 5 bucks doe.",
  "",
  "```comments",
  'k7f2 "free, you cheapo"',
  "- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.",
  "```",
  "",
].join("\n");

function stateFor(doc: string, author: string | null = "@dev2") {
  return EditorState.create({ doc, extensions: [comments({ author: () => author })] });
}

group("the margin's rules", () => {
  test("a person is an @handle and an agent is anything else", () => {
    expect(isPerson("@dev2")).toBe(true);
    expect(isPerson("Codex")).toBe(false);
    expect(isPerson("dev2")).toBe(false);
  });

  test("initials: one letter for a person, two for an agent", () => {
    expect(initialsFor("@dev2")).toBe("D");
    expect(initialsFor("Codex")).toBe("Co");
    expect(initialsFor("Claude Code")).toBe("CC");
  });

  test("times read as a short age", () => {
    const now = Date.parse("2026-09-27T08:00:00Z");
    expect(whenLabel("2026-09-27T07:59:30Z", now)).toBe("now");
    expect(whenLabel("2026-09-27T07:30:00Z", now)).toBe("30m");
    expect(whenLabel("2026-09-27T05:00:00Z", now)).toBe("3h");
    expect(whenLabel("not a time", now)).toBe("");
  });

  test("resolved threads are hidden until asked for", () => {
    const threads = parseComments(NOTE.replace("```\n", "- 2026-09-27T07:31:45Z @dev2 resolved\n```\n")).threads;
    expect(visibleThreads(threads, false)).toHaveLength(0);
    expect(visibleThreads(threads, true)).toHaveLength(1);
  });

  test("cards never overlap, and each sits as close to its line as it can", () => {
    const placed = stackCards(
      [
        { id: "a", want: 0, height: 100 },
        { id: "b", want: 40, height: 50 },
        { id: "c", want: 400, height: 50 },
      ],
      null,
      8,
    );
    expect(placed).toEqual([
      { id: "a", top: 0 },
      { id: "b", top: 108 },
      { id: "c", top: 400 },
    ]);
  });

  test("the active card sits exactly on its line and pushes the ones above up", () => {
    const placed = stackCards(
      [
        { id: "a", want: 0, height: 100 },
        { id: "b", want: 40, height: 50 },
      ],
      "b",
      8,
    );
    expect(placed).toEqual([
      { id: "a", top: -68 },
      { id: "b", top: 40 },
    ]);
  });
});

group("the editor's view of the file", () => {
  test("the threads and anchors are read from the document", () => {
    const parsed = stateFor(NOTE).field(commentsParsed);
    expect(parsed.threads.map((t) => t.id)).toEqual(["k7f2"]);
    expect(parsed.markers).toHaveLength(2);
  });

  test("the block and the blank line above it are hidden as whole lines", () => {
    const state = stateFor(NOTE);
    const block = state.field(commentsParsed).block!;
    const hidden = hiddenBlockRange(state, block);
    expect(state.sliceDoc(hidden.from, hidden.to)).toBe(
      '\n```comments\nk7f2 "free, you cheapo"\n- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.\n```',
    );
    expect(state.sliceDoc(0, hidden.from)).toBe("# <!--c:k7f2-->free, you cheapo<!--/c:k7f2--> :annoyed:\n\nPremium is like 5 bucks doe.\n");
  });

  test("a draft follows its words when text is typed above them", () => {
    let state = stateFor(NOTE);
    const from = NOTE.indexOf("Premium");
    state = state.update({ effects: setDraft.of({ from, to: from + 7 }) }).state;
    state = state.update({ changes: { from: 0, insert: "Hello\n" } }).state;
    const draft = state.field(commentUi).draft!;
    expect(state.sliceDoc(draft.from, draft.to)).toBe("Premium");
  });

  test("showing resolved threads is UI state and never touches the file", () => {
    const state = stateFor(NOTE);
    const next = state.update({ effects: setShowResolved.of(true) }).state;
    expect(next.doc.toString()).toBe(NOTE);
    expect(next.field(commentUi).showResolved).toBe(true);
  });

  test("commenting on a selection inserts two markers and one block, and nothing else", () => {
    const plain = "# Pricing\n\nfree, you cheapo\n";
    let state = stateFor(plain);
    const from = plain.indexOf("you cheapo");
    state = state.update({ effects: setDraft.of({ from, to: from + 10 }) }).state;
    const spec = draftTransaction(state, "Tone it down.");
    expect("error" in spec).toBe(false);
    const next = state.update(spec as TransactionSpec).state;
    const text = next.doc.toString();
    const parsed = parseComments(text);
    const id = parsed.threads[0]!.id;
    expect(text.startsWith(`# Pricing\n\nfree, <!--c:${id}-->you cheapo<!--/c:${id}-->\n\n\`\`\`comments\n`)).toBe(true);
    expect(parsed.threads[0]!.events[0]).toMatchObject({ author: "@dev2", text: "Tone it down." });
    expect(next.field(commentUi)).toMatchObject({ draft: null, active: id });
    // The caret ends past the closing marker, so the selection is gone.
    expect(next.selection.main.empty).toBe(true);
    expect(text.slice(0, next.selection.main.head).endsWith(`you cheapo<!--/c:${id}-->`)).toBe(true);
  });

  test("a reply and a resolve are appended, never rewritten", () => {
    let state = stateFor(NOTE);
    state = state.update(threadTransaction(state, "k7f2", "comment", "eh, I don't really care") as TransactionSpec).state;
    state = state.update(threadTransaction(state, "k7f2", "resolved") as TransactionSpec).state;
    const text = state.doc.toString();
    expect(text.startsWith(NOTE.slice(0, NOTE.indexOf("```\n", NOTE.indexOf("Codex"))))).toBe(true);
    const thread = parseComments(text).threads[0]!;
    expect(thread.events.map((e) => e.kind)).toEqual(["comment", "comment", "resolved"]);
    expect(thread.status).toBe("resolved");
  });

  test("nobody signed in, or a read-only note, cannot comment", () => {
    expect("error" in threadTransaction(stateFor(NOTE, null), "k7f2", "comment", "hi")).toBe(true);
    const readOnly = EditorState.create({ doc: NOTE, extensions: [comments({ author: () => "@dev2" }), EditorState.readOnly.of(true)] });
    expect("error" in threadTransaction(readOnly, "k7f2", "resolved")).toBe(true);
  });
});
