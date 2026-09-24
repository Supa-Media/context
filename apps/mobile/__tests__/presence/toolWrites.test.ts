/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { electWriter, isWriter, seedSharedDoc } from "../../features/console/presence/sharedDoc";
import { applyExternalWrite } from "../../features/console/presence/externalWrite";
import { newDrawing, serializeDrawing } from "@context/drawings";
import { pair } from "./fixtures";

/*
  A TOOL'S VERSION MAY ONLY BE ADOPTED BY A CLIENT THAT RECEIVED ITS CONTENT.

  A console save is a conditional write against the etag the editor holds, and
  that refusal is the only thing between a stale draft and a silent overwrite.
  Moving the etag spends it. So the two halves of a write — its content and its
  version — travel together or not at all.

  These checks are here rather than in the hook because `usePresence`'s socket
  handler is not reachable by any test in this repository, which
  `docs/decisions/testing.md` now states outright. That is exactly why the
  decision was moved out of it: measured beforehand, inverting the `if` that
  used to live there failed **0** of the app's tests.
*/
describe("a tool's write, and the version that comes with it", () => {
  /*
    Built with the package's own serializer rather than hand-written, so the
    fixture is a drawing by construction: a hand-rolled payload that stopped
    parsing would turn these checks green for the wrong reason.
  */

  /**
   * Every sink, recorded.
   *
   * One recorder rather than a counter per test: the defects this describe
   * exists for were all "the right thing happened and the wrong thing also
   * did", and a test that counts only what it expects cannot see the second
   * half of that.
   */
  function sinks() {
    const seen = {
      delivered: [] as unknown[][],
      shared: [] as unknown[][],
      carets: [] as { from: number; to: number }[],
      pointers: [] as { x: number; y: number }[],
      adopted: 0,
    };
    return {
      seen,
      deliverElements: (elements: unknown[]) => seen.delivered.push(elements),
      shareElements: (elements: unknown[]) => seen.shared.push(elements),
      reportCaret: (span: { from: number; to: number }) => seen.carets.push(span),
      reportPointer: (at: { x: number; y: number }) => seen.pointers.push(at),
      adopt: () => {
        seen.adopted += 1;
      },
    };
  }

  const DRAWING_PATH = "1-projects/plan.excalidraw.md";
  const blank = newDrawing() as string;
  const oneShape = serializeDrawing(blank, [
    { id: "one", type: "rectangle", version: 3, versionNonce: 7, x: 0, y: 0, width: 10, height: 10 },
  ] as never[]) as string;
  const emptyScene = serializeDrawing(blank, [] as never[]) as string;

  test("a note adopts it, and holds the text that came with it", () => {
    const { a, b } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const out = sinks();
    applyExternalWrite(
      { text: "# Notes\n\nfirst line\nfrom a tool\n", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect(out.seen.adopted).toBe(1);
    expect(a.markdown()).toBe("# Notes\n\nfirst line\nfrom a tool\n");
    // The peer bound to the same document has it too, which is what makes
    // adopting the version safe rather than only defensible.
    expect(b.markdown()).toBe(a.markdown());
  });

  test("a merge that throws does not move the version", () => {
    /*
      The document is left exactly as it was, so this client does not hold the
      tool's text — and the branch that swallowed the throw moved the version
      regardless, reasoning that "the bucket has the tool's version either
      way". True before the version moved; false after it.
    */
    const { a } = pair();
    seedSharedDoc(a, "intact");
    const exploding = {
      ...a,
      doc: {
        ...a.doc,
        transact: () => {
          throw new Error("a document mid-transaction");
        },
      },
    } as unknown as typeof a;
    const out = sinks();
    applyExternalWrite(
      { text: "something else", path: "1-projects/n.md", shared: exploding, drawing: false },
      out,
    );
    // No version, and no caret either: a caret drawn for a merge that did not
    // happen points at text nobody in this room can see.
    expect([out.seen.adopted, out.seen.carets.length]).toEqual([0, 0]);
    expect(a.markdown()).toBe("intact");
  });

  test("a canvas adopts it only once the elements are delivered", () => {
    const out = sinks();
    applyExternalWrite({ text: oneShape, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect(out.seen.delivered.length).toBe(1);
    expect((out.seen.delivered[0] as { id: string }[]).map((element) => element.id)).toEqual(["one"]);
    expect(out.seen.adopted).toBe(1);
  });

  test("a payload carrying no elements delivers nothing and moves nothing", () => {
    /*
      Not a cleared canvas — Excalidraw deletes by flag, so a real clear
      arrives as elements carrying `isDeleted`. This is a scene this client
      cannot be brought onto, and claiming its version would have the next save
      put the old shapes back over it.
    */
    const out = sinks();
    applyExternalWrite({ text: emptyScene, path: DRAWING_PATH, shared: null, drawing: true }, out);
    // Nothing delivered, nothing re-broadcast, no pointer, no version.
    expect([
      out.seen.delivered.length,
      out.seen.shared.length,
      out.seen.pointers.length,
      out.seen.adopted,
    ]).toEqual([0, 0, 0, 0]);
  });

  test("a payload this console could not have opened delivers nothing either", () => {
    /*
      `parseDrawing` reports rather than throws, for all three of its reasons,
      so this is the branch that has to carry them. Each one arrives with
      `elements: null` and must leave the version where it is.

      Measured before it was written: a `catch` here failed **0** checks,
      because nothing makes that parser throw. A guard around a throw that
      cannot happen is not a guard.
    */
    for (const text of ["# just a note", "", "```compressed-json\nnot-base64!!\n```"]) {
      const out = sinks();
      applyExternalWrite({ text, path: DRAWING_PATH, shared: null, drawing: true }, out);
      expect([text, out.seen.delivered.length, out.seen.shared.length, out.seen.adopted]).toEqual([
        text,
        0,
        0,
        0,
      ]);
    }
  });

  test("a room that is neither receives nothing", () => {
    // No document and not a canvas: there is nothing here that could take the
    // write, so there is nothing that may take its version.
    const out = sinks();
    applyExternalWrite({ text: "anything", path: "1-projects/n.md", shared: null, drawing: false }, out);
    expect(out.seen.adopted).toBe(0);
  });

  /*
    A TOOL IS SOMEBODY IN THE ROOM, NOT TEXT THAT APPEARS FROM NOWHERE.

    Watching an agent work was the point of the whole feature, and the first
    version of it delivered the agent's write to one browser and told nobody:
    the second person on a note saw the paragraph (it is an edit, and edits
    travel) and the second person on a *canvas* saw nothing at all, because
    elements handed to one browser's Excalidraw go nowhere.

    So the client the room asked to merge owes the room two things afterwards,
    and they are the two halves below.
  */
  test("a tool's caret is reported where its text landed", () => {
    const { a } = pair();
    seedSharedDoc(a, "# Notes\n\nfirst line\n");
    const out = sinks();
    applyExternalWrite(
      { text: "# Notes\n\nfirst line\nfrom a tool\n", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect(out.seen.carets.length).toBe(1);
    const span = out.seen.carets[0];
    expect(a.markdown().slice(span.from, span.to)).toBe("from a tool\n");
  });

  test("a tool that changed nothing gets no caret", () => {
    // A rewrite of identical content is not somebody working in the note, and
    // a caret would say it was. The version still moves: the bucket did.
    const { a } = pair();
    seedSharedDoc(a, "unchanged");
    const out = sinks();
    applyExternalWrite(
      { text: "unchanged", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect([out.seen.carets.length, out.seen.adopted]).toEqual([0, 1]);
  });

  test("a tool's elements go to everybody else, not just to this browser", () => {
    /*
      The defect, exactly: the room hands a canvas write to one member because
      the same *text* merged twice inserts it twice — but elements reconcile by
      version, so the second person's canvas stayed empty for no reason at all.
      Delivered here and re-broadcast, and the same elements in both.
    */
    const out = sinks();
    applyExternalWrite({ text: oneShape, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect(out.seen.shared.length).toBe(1);
    expect((out.seen.shared[0] as { id: string }[]).map((one) => one.id)).toEqual(["one"]);
    expect(out.seen.shared[0]).toEqual(out.seen.delivered[0]);
  });

  test("a note's merge is not re-broadcast, because it already travels", () => {
    // The other half of the rule above, and the one that would be a duplicated
    // paragraph rather than a redundant frame: text merged into the shared
    // document reaches every peer down the ordinary update path.
    const { a } = pair();
    seedSharedDoc(a, "first\n");
    const out = sinks();
    applyExternalWrite(
      { text: "first\nsecond\n", path: "1-projects/n.md", shared: a, drawing: false },
      out,
    );
    expect([out.seen.shared.length, out.seen.delivered.length]).toEqual([0, 0]);
  });

  test("a tool's pointer lands on the shape it just drew", () => {
    const recent = serializeDrawing(blank, [
      { id: "old", type: "rectangle", version: 40, versionNonce: 1, updated: 1_000, x: 0, y: 0, width: 10, height: 10 },
      { id: "new", type: "rectangle", version: 1, versionNonce: 2, updated: 2_000, x: 100, y: 100, width: 20, height: 20 },
    ] as never[]) as string;
    const out = sinks();
    applyExternalWrite({ text: recent, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect(out.seen.pointers).toEqual([{ x: 110, y: 110 }]);
  });

  test("a scene with no honest position gets no pointer, and still adopts", () => {
    /*
      `oneShape` carries no `updated` — it is hand-built above — which is the
      case of a tool that wrote a file without going through Excalidraw. A
      pointer at the origin would claim the tool is working in the top-left
      corner of somebody's canvas. Withholding the *version* over it would be
      the separate, worse bug: the shapes arrived, which is the whole test.
    */
    const out = sinks();
    applyExternalWrite({ text: oneShape, path: DRAWING_PATH, shared: null, drawing: true }, out);
    expect([out.seen.pointers.length, out.seen.adopted]).toEqual([0, 1]);
  });

  test("exactly one member is the writer, and it survives them leaving", () => {
    // Two writers would race to save the same document and conflict with each
    // other — the bug this feature removes, reintroduced from the other end.
    expect(isWriter("m2", ["m3", "m9"])).toBe(true);
    expect(isWriter("m9", ["m2", "m3"])).toBe(false);
    // m2 left; m3 takes over off the very next roster, with no gap.
    expect(isWriter("m3", ["m9"])).toBe(true);
    expect(isWriter(null, ["m1"])).toBe(false);
  });

  test("the election skips members the room would refuse an edit from", () => {
    /*
      A room whose lowest member id belongs to a read-only viewer used to elect
      that viewer, and then nobody saved at all: the one client that believed
      it was saving was the one whose frames the room drops. Both halves are
      checked, because leaving either out reintroduces it.
    */
    const viewer = { id: "m1", canWrite: false };
    const later = { id: "m9", canWrite: true };

    /*
      **The roster never contains the caller**, which these calls used to get
      wrong — they passed the caller's own entry in `members` and so tested a
      shape `session.ts` does not produce. Your own authority is the second
      argument now; the list is the other people.
    */
    expect(electWriter("m2", true, [viewer, later])).toBe(true);
    expect(electWriter("m1", false, [later])).toBe(false);
    expect(electWriter("m9", true, [viewer, { id: "m2", canWrite: true }])).toBe(false);

    // A read-only member alone in a room elects nobody, rather than itself
    // against an empty field.
    expect(electWriter("m1", false, [])).toBe(false);

    // And when the only editor leaves, the next one takes over off the very
    // next roster.
    expect(electWriter("m9", true, [viewer])).toBe(true);

    // Nobody is elected before the room has named this client.
    expect(electWriter(null, true, [later])).toBe(false);
  });
});
