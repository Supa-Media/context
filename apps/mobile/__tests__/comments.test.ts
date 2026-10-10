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
import { commenterFor, eventsKey, isPerson, FOLD_HEIGHT, FOLD_SLACK, keepInView, layoutMargin, mayDelete, visibleThreads, whenLabel } from "../features/console/files/comments/model";
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

  test("comments spread down a note each sit on their own line", () => {
    const { placed, folds } = layoutMargin(
      [
        { id: "a", want: 0, height: 100, foldable: true },
        { id: "b", want: 400, height: 50, foldable: true },
        { id: "c", want: 900, height: 50, foldable: true },
      ],
      null,
    );
    expect(placed).toEqual([
      { id: "a", top: 0 },
      { id: "b", top: 400 },
      { id: "c", top: 900 },
    ]);
    expect(folds).toEqual([]);
  });

  // Dev2, 2026-10-10: crowded cards fold into one "N more here" row at the
  // spot, instead of being pushed away from their lines or onto each other.
  test("cards that would be pushed away from their line fold into one row there", () => {
    const { placed, folds } = layoutMargin(
      [
        { id: "a", want: 100, height: 150, foldable: true },
        { id: "b", want: 128, height: 80, foldable: true },
        { id: "c", want: 156, height: 80, foldable: true },
        { id: "d", want: 212, height: 80, foldable: true },
        { id: "far", want: 900, height: 50, foldable: true },
      ],
      null,
    );
    expect(placed).toEqual([
      { id: "a", top: 100 },
      { id: "far", top: 900 },
    ]);
    expect(folds).toEqual([{ key: "b", ids: ["b", "c", "d"], top: 258, open: false }]);
  });

  test("a card only slightly below its line stays a full card", () => {
    const { placed, folds } = layoutMargin(
      [
        { id: "a", want: 0, height: 60, foldable: true },
        { id: "b", want: 40, height: 60, foldable: true },
      ],
      null,
    );
    expect(placed).toEqual([
      { id: "a", top: 0 },
      { id: "b", top: 68 },
    ]);
    expect(folds).toEqual([]);
  });

  test("opening a folded thread opens its row, with every thread in it stacked below", () => {
    const cards = [
      { id: "a", want: 100, height: 150, foldable: true },
      { id: "b", want: 128, height: 80, foldable: true },
      { id: "c", want: 156, height: 80, foldable: true },
      { id: "far", want: 400, height: 50, foldable: true },
    ];
    const { placed, folds } = layoutMargin(cards, "c");
    expect(placed).toEqual([
      { id: "a", top: 100 },
      { id: "b", top: 296 },
      { id: "c", top: 384 },
    ]);
    // "far" sat on its own line until the open row pushed it 72px down: it
    // folds into a row of its own rather than joining the open one.
    expect(folds).toEqual([
      { key: "b", ids: ["b", "c"], top: 258, open: true },
      { key: "far", ids: ["far"], top: 472, open: false },
    ]);
  });

  test("clicking a card never pushes the cards above it up", () => {
    const cards = [
      { id: "a", want: 0, height: 100, foldable: true },
      { id: "b", want: 40, height: 50, foldable: true },
      { id: "c", want: 300, height: 50, foldable: true },
    ];
    expect(layoutMargin(cards, "c").placed).toEqual(layoutMargin(cards, null).placed);
    expect(layoutMargin(cards, "c").placed.every((card) => card.top >= 0)).toBe(true);
  });

  test("the draft and the resolved toggle never fold", () => {
    const { placed, folds } = layoutMargin(
      [
        { id: "a", want: 100, height: 150, foldable: true },
        { id: "__draft", want: 120, height: 90, foldable: false },
      ],
      "__draft",
    );
    expect(placed).toEqual([
      { id: "a", top: 100 },
      { id: "__draft", top: 258 },
    ]);
    expect(folds).toEqual([]);
  });

  test("whatever the comments, nothing drawn overlaps, nothing goes above the note, and every card is near its line", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let run = 0; run < 300; run += 1) {
      const count = 1 + Math.floor(random() * 12);
      const cards = Array.from({ length: count }, (_, i) => ({
        id: `t${i}`,
        want: Math.floor(random() * 800),
        height: 40 + Math.floor(random() * 200),
        foldable: random() > 0.1,
      }));
      const active = random() > 0.5 ? cards[Math.floor(random() * count)]!.id : null;
      const { placed, folds } = layoutMargin(cards, active);
      const byId = new Map(cards.map((card) => [card.id, card]));
      const boxes = [
        ...placed.map((card) => ({ top: card.top, bottom: card.top + byId.get(card.id)!.height })),
        ...folds.map((fold) => ({ top: fold.top, bottom: fold.top + FOLD_HEIGHT })),
      ].sort((x, y) => x.top - y.top);
      for (let i = 1; i < boxes.length; i += 1) expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom);
      expect(boxes.every((box) => box.top >= 0)).toBe(true);
      const inOpenFold = new Set(folds.filter((fold) => fold.open).flatMap((fold) => fold.ids));
      for (const card of placed) {
        const item = byId.get(card.id)!;
        if (item.foldable && !inOpenFold.has(card.id)) expect(card.top - item.want).toBeLessThanOrEqual(FOLD_SLACK);
      }
      // Lifting to fit the screen keeps all of that, and only the lowest box
      // it lifts may rise above its own line.
      const boxesIn = [
        ...placed.map((card) => ({ ...card, want: byId.get(card.id)!.want, height: byId.get(card.id)!.height })),
        ...folds.map((fold) => ({ id: `fold:${fold.key}`, top: fold.top, want: byId.get(fold.key)!.want, height: FOLD_HEIGHT })),
      ];
      const viewTop = Math.floor(random() * 600);
      const lifted = keepInView(boxesIn, { top: viewTop, bottom: viewTop + 200 + Math.floor(random() * 500) });
      const before = new Map(boxesIn.map((box) => [box.id, box]));
      const after = lifted
        .map((box) => ({ ...box, bottom: box.top + before.get(box.id)!.height }))
        .sort((x, y) => x.top - y.top);
      for (let i = 1; i < after.length; i += 1) expect(after[i]!.top).toBeGreaterThanOrEqual(after[i - 1]!.bottom);
      expect(after.every((box) => box.top >= 0 && box.top <= before.get(box.id)!.top)).toBe(true);
      const risen = after.filter((box) => box.top < Math.min(before.get(box.id)!.top, before.get(box.id)!.want));
      expect(risen.length).toBeLessThanOrEqual(1);
      // Every thread is either drawn or counted in a row: none goes missing.
      const shown = new Set([...placed.map((card) => card.id), ...folds.flatMap((fold) => fold.ids)]);
      expect(shown.size).toBe(count);
    }
  });

  test("a card on one of the last lines is lifted to fit on screen, and never onto another", () => {
    const boxes = [
      { id: "a", want: 100, top: 100, height: 60 },
      { id: "b", want: 500, top: 500, height: 200 },
      { id: "far", want: 2000, top: 2000, height: 50 },
    ];
    // The pane shows 0–600: b's line is on screen but its card runs to 700.
    expect(keepInView(boxes, { top: 0, bottom: 600 }, 8)).toEqual([
      { id: "a", top: 100 },
      { id: "b", top: 400 },
      { id: "far", top: 2000 },
    ]);
    // Lifting b to fit would push a 58px above its own line, so a stays on
    // its line and b is lifted only as far as a allows.
    const tall = [
      { id: "a", want: 100, top: 100, height: 200 },
      { id: "b", want: 320, top: 320, height: 250 },
    ];
    expect(keepInView(tall, { top: 0, bottom: 500 }, 8)).toEqual([
      { id: "a", top: 100 },
      { id: "b", top: 308 },
    ]);
    // Everything already fits: nothing moves.
    expect(keepInView(boxes, { top: 0, bottom: 3000 }, 8)).toEqual(boxes.map(({ id, top }) => ({ id, top })));
  });

  test("a lifted card never pushes a card whose line is above the screen above that line", () => {
    // a's line is scrolled off the top, but its card reaches down into view.
    const boxes = [
      { id: "a", want: 80, top: 80, height: 300 },
      { id: "b", want: 400, top: 400, height: 200 },
    ];
    const placed = keepInView(boxes, { top: 100, bottom: 500 }, 8);
    // Lifting b to 300 would push a to -8, above its line at 80, so the
    // lift gives way: b stops just under a and is cut off at the bottom.
    expect(placed).toEqual([
      { id: "a", top: 80 },
      { id: "b", top: 388 },
    ]);
  });

  test("lifting never pushes a card above the top of the note", () => {
    const boxes = [
      { id: "a", want: 0, top: 0, height: 300 },
      { id: "b", want: 310, top: 310, height: 300 },
    ];
    const placed = keepInView(boxes, { top: 0, bottom: 400 }, 8);
    expect(placed).toEqual([
      { id: "a", top: 0 },
      { id: "b", top: 308 },
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
