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
  deleteTransaction,
  draftTransaction,
  hiddenBlockRange,
  threadTransaction,
  setActiveThread,
  setDraft,
  setShowResolved,
} from "../features/console/files/comments/extension";
import { commenterFor, eventsKey, isPerson, mayDelete, stackCards, visibleThreads, whenLabel } from "../features/console/files/comments/model";
import { shiftFor } from "../features/console/files/comments/rail";

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

function stateFor(doc: string, author: string | null = "@dev2", moderator = false) {
  return EditorState.create({ doc, extensions: [comments({ author: () => author, moderator: () => moderator })] });
}

group("the margin's rules", () => {
  test("a person is an @handle and an agent is anything else", () => {
    expect(isPerson("@dev2")).toBe(true);
    expect(isPerson("Codex")).toBe(false);
    expect(isPerson("dev2")).toBe(false);
    expect(isPerson("@jon's Claude")).toBe(false);
  });

  test("who a comment is signed as: a handle, a homepage visitor, or nobody", () => {
    expect(commenterFor("@dev2", false)).toBe("@dev2");
    expect(commenterFor("@dev2", true)).toBe("@dev2");
    // A visitor comments like they edit: in their own tab.
    expect(commenterFor("Signed in", true)).toBe("@you");
    expect(commenterFor(undefined, true)).toBe("@you");
    // A signed-in reader without a handle yet has nothing to sign with.
    expect(commenterFor("someone@example.com", false)).toBeNull();
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

group("the column moves only by what a card is short of", () => {
  test("room enough beside the column: the note stays exactly where it is", () => {
    expect(shiftFor(296)).toBe(0);
    expect(shiftFor(420)).toBe(0);
  });

  test("a little short: the column moves by the shortfall, in steps of 8px", () => {
    // Dev2's window: about 228px beside a centred column.
    expect(shiftFor(228)).toBe(72);
    expect(shiftFor(290)).toBe(8);
  });

  test("never more than the full margin", () => {
    expect(shiftFor(-500)).toBe(300);
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

group("deleting a comment", () => {
  const THREADED = NOTE.replace(
    "- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.\n",
    "- 2026-09-27T07:30:12Z Codex: This seems a little unprofessional.\n- 2026-09-27T07:31:40Z @dev2: eh\n- 2026-09-27T07:32:00Z @sayo: agreed\n",
  );
  const said = (doc: string) => parseComments(doc).threads[0]!.events.filter((e) => e.kind === "comment");

  test("a person deletes their own comments; an owner deletes anybody's; nobody signed in deletes nothing", () => {
    expect(mayDelete("@dev2", "@dev2", false)).toBe(true);
    expect(mayDelete("@sayo", "@dev2", false)).toBe(false);
    expect(mayDelete("Codex", "@dev2", false)).toBe(false);
    expect(mayDelete("@sayo", "@dev2", true)).toBe(true);
    expect(mayDelete("@dev2", null, true)).toBe(false);
  });

  test("deleting your own reply removes only its line", () => {
    const state = stateFor(THREADED);
    const spec = deleteTransaction(state, "k7f2", 1, said(THREADED)[1]!);
    expect("error" in spec).toBe(false);
    const text = state.update(spec as TransactionSpec).state.doc.toString();
    expect(text).toBe(THREADED.replace("- 2026-09-27T07:31:40Z @dev2: eh\n", ""));
  });

  test("somebody else's comment is refused unless the viewer is an owner", () => {
    expect("error" in deleteTransaction(stateFor(THREADED), "k7f2", 2, said(THREADED)[2]!)).toBe(true);
    const owner = stateFor(THREADED, "@dev2", true);
    const text = owner.update(deleteTransaction(owner, "k7f2", 2, said(THREADED)[2]!) as TransactionSpec).state.doc.toString();
    expect(text).not.toContain("agreed");
  });

  test("deleting the first comment deletes the thread, its markers and the block, and closes the card", () => {
    let state = stateFor(THREADED, "@dev2", true);
    state = state.update({ effects: setActiveThread.of("k7f2") }).state;
    const next = state.update(deleteTransaction(state, "k7f2", 0, said(THREADED)[0]!) as TransactionSpec).state;
    expect(next.doc.toString()).toBe("# free, you cheapo :annoyed:\n\nPremium is like 5 bucks doe.\n");
    expect(next.field(commentUi).active).toBeNull();
  });

  test("a comment that moved since the reader saw it is refused, not guessed at", () => {
    const state = stateFor(THREADED, "@dev2", true);
    expect("error" in deleteTransaction(state, "k7f2", 1, said(THREADED)[2]!)).toBe(true);
  });

  test("a read-only note offers no delete", () => {
    const readOnly = EditorState.create({ doc: THREADED, extensions: [comments({ author: () => "@dev2" }), EditorState.readOnly.of(true)] });
    expect("error" in deleteTransaction(readOnly, "k7f2", 1, said(THREADED)[1]!)).toBe(true);
  });

  test("a card is keyed on what the thread says, not where its lines sit", () => {
    const moved = `Intro line.\n\n${THREADED}`;
    expect(eventsKey(parseComments(moved).threads[0]!)).toEqual(eventsKey(parseComments(THREADED).threads[0]!));
  });
});
