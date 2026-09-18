/**
 * IMAGES IN A NOTE — every decision a gesture makes, without a pointer.
 *
 * The module is split so that this file can exist: a drag, a drop and a paste
 * each end in a pure planner that takes a state and returns a transaction, and
 * the DOM code above them does no arithmetic. What is pinned here is therefore
 * the whole behaviour, not a proxy for it:
 *
 *  - a line that is only embeds is drawn; a sentence with an image in it is not,
 *    and an embed inside a fence is an example rather than an image;
 *  - the reveal rule — the row withdraws the instant the selection reaches it,
 *    because a width you cannot see is a width you cannot edit by hand;
 *  - snapping to the measure, and ⌥ turning it off;
 *  - a drop onto a row joins them (side by side), a drop anywhere else moves the
 *    line, and a drop on its own line changes nothing at all;
 *  - a paste lands on its own line, because a row is a line.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState, type TransactionSpec } from "@codemirror/state";

import { markdownLanguage, selectionTouches } from "../features/console/files/livePreview";
import {
  MIN_IMAGE_WIDTH,
  imageFilesFrom,
  imageRows,
  inCode,
  planAlign,
  planDrop,
  planInsert,
  planResize,
  widthFromDrag,
  type ImageRow,
} from "../features/console/files/imageBlock";
import { base64FromBytes, dataUrlFor } from "../features/console/files/imageBytes";

function stateFor(doc: string, cursor?: number): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdownLanguage()],
    ...(cursor === undefined ? {} : { selection: { anchor: cursor } }),
  });
}

/** The rows this state would draw, under the same reveal rule as the editor. */
function rowsOf(state: EditorState): ImageRow[] {
  const selection = state.readOnly
    ? []
    : state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
  return imageRows(state, (range) => selectionTouches(range, selection));
}

/** The text a transaction spec would leave behind. */
function applied(state: EditorState, spec: TransactionSpec | null): string {
  if (spec === null) return state.doc.toString();
  return state.update(spec).state.doc.toString();
}

describe("which lines are drawn as images", () => {
  test("a line of one embed is a row", () => {
    const rows = rowsOf(stateFor("# Note\n\n![[a.png|320]]\n\nafter"));
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe("![[a.png|320]]");
    expect(rows[0].line.images[0].width).toBe(320);
  });

  test("two embeds on one line are one row of two images", () => {
    // The caret is parked away from the row: with it on the line, the reveal
    // rule gives the markup back, which the case below this one is about.
    const rows = rowsOf(stateFor("![[a.png|320]] ![[b.png|320]]\n\nafter", 33));
    expect(rows.length).toBe(1);
    expect(rows[0].line.images.length).toBe(2);
  });

  test("a sentence with an image in it is left as text", () => {
    expect(rowsOf(stateFor("see ![[a.png]] here")).length).toBe(0);
  });

  test("an embed inside a fence is an example, not an image", () => {
    const doc = "```md\n![[a.png|320]]\n```\n";
    expect(inCode(stateFor(doc), doc.indexOf("![[") + 1)).toBe(true);
    expect(rowsOf(stateFor(doc)).length).toBe(0);
  });

  test("the row withdraws when the selection reaches its line", () => {
    const doc = "![[a.png|320]]\n\nafter";
    expect(rowsOf(stateFor(doc, 0)).length).toBe(0);
    expect(rowsOf(stateFor(doc, 5)).length).toBe(0);
    expect(rowsOf(stateFor(doc, doc.length)).length).toBe(1);
  });

  test("a read-only note draws every row, because nothing reveals there", () => {
    const state = EditorState.create({
      doc: "![[a.png]]",
      extensions: [markdownLanguage(), EditorState.readOnly.of(true)],
    });
    expect(rowsOf(state).length).toBe(1);
  });

  test("several rows in one note are all found, in document order", () => {
    const rows = rowsOf(stateFor("![[a.png]]\n\ntext\n\n![[b.png]] ![[c.png]]", 14));
    expect(rows.map((row) => row.line.images.length)).toEqual([1, 2]);
  });
});

describe("the width a drag reaches", () => {
  test("it snaps to the quarters of the measure", () => {
    expect(widthFromDrag({ startWidth: 320, deltaX: 4, measure: 640 })).toBe(320);
    expect(widthFromDrag({ startWidth: 320, deltaX: 150, measure: 640 })).toBe(480);
    expect(widthFromDrag({ startWidth: 320, deltaX: -155, measure: 640 })).toBe(160);
    expect(widthFromDrag({ startWidth: 480, deltaX: 200, measure: 640 })).toBe(640);
  });

  test("alt skips the snapping, and nothing else does", () => {
    expect(widthFromDrag({ startWidth: 320, deltaX: 150, measure: 640, precise: true })).toBe(470);
  });

  test("it never goes below a thumbnail or past the measure", () => {
    expect(widthFromDrag({ startWidth: 320, deltaX: -4000, measure: 640 })).toBe(MIN_IMAGE_WIDTH);
    expect(widthFromDrag({ startWidth: 320, deltaX: 4000, measure: 640 })).toBe(640);
  });
});

describe("resizing and aligning write one line", () => {
  test("a resize replaces the width and nothing else", () => {
    const state = stateFor("before\n\n![[a.png|320]] ![[b.png|320]]\n\nafter", 0);
    const row = rowsOf(state)[0];
    expect(applied(state, planResize(state, row, 1, 200))).toBe(
      "before\n\n![[a.png|320]] ![[b.png|200]]\n\nafter",
    );
  });

  test("a resize to the width it already has is not an edit at all", () => {
    const state = stateFor("![[a.png|320]]\n\nx", 16);
    expect(planResize(state, rowsOf(state)[0], 0, 320)).toBeNull();
  });

  test("alignment is a comment, and left takes it away again", () => {
    const state = stateFor("![[a.png|320]]\n\nx", 16);
    const row = rowsOf(state)[0];
    expect(applied(state, planAlign(state, row, "center"))).toBe(
      "![[a.png|320]] <!-- context: align=center -->\n\nx",
    );
    const centered = stateFor("![[a.png|320]] <!-- context: align=center -->\n\nx", 47);
    expect(applied(centered, planAlign(centered, rowsOf(centered)[0], "left"))).toBe(
      "![[a.png|320]]\n\nx",
    );
  });

  test("a centred row is still a row", () => {
    const rows = rowsOf(stateFor("![[a.png]] <!-- context: align=center -->\n\nx", 43));
    expect(rows.length).toBe(1);
    expect(rows[0].line.align).toBe("center");
  });
});

describe("dropping an image", () => {
  test("onto another row, the two join and the empty line goes", () => {
    const doc = "![[a.png|320]]\n\nwords\n\n![[b.png|240]]";
    const state = stateFor(doc, 16);
    const row = rowsOf(state).find((candidate) => candidate.text.includes("b.png"))!;
    expect(applied(state, planDrop(state, row, 0, 2))).toBe(
      "![[a.png|320]] ![[b.png|240]]\n\nwords",
    );
  });

  test("onto a paragraph, the whole line moves there", () => {
    const doc = "one\n\n![[a.png]]\n\ntwo";
    const state = stateFor(doc, 0);
    const row = rowsOf(state)[0];
    expect(applied(state, planDrop(state, row, 0, doc.indexOf("two")))).toBe(
      "one\n\ntwo\n\n![[a.png]]",
    );
  });

  test("onto its own line, nothing happens and nothing lands in history", () => {
    const state = stateFor("![[a.png]]\n\nx", 12);
    expect(planDrop(state, rowsOf(state)[0], 0, 3)).toBeNull();
  });

  test("a row of two dropped on a row of one leaves the other behind", () => {
    const doc = "![[a.png]]\n\n![[b.png]] ![[c.png]]";
    const state = stateFor(doc, 0);
    const row = rowsOf(state).find((candidate) => candidate.text.includes("b.png"))!;
    expect(applied(state, planDrop(state, row, 0, 2))).toBe(
      "![[a.png]] ![[b.png]]\n\n![[c.png]]",
    );
  });
});

describe("where a pasted image lands", () => {
  test("an empty line takes it, and the caret goes below it", () => {
    const state = stateFor("words\n\n", 7);
    const next = state.update(planInsert(state, "paste-abc.png", null)).state;
    expect(next.doc.toString()).toBe("words\n\n![[paste-abc.png]]\n");
    // The caret is NOT on the image's line: the reveal rule would otherwise
    // give the markup back, and a paste would show a link instead of a picture.
    expect(next.doc.lineAt(next.selection.main.head).number).toBe(4);
  });

  test("a line with text on it gets the image under it, and the caret under that", () => {
    const state = stateFor("words", 3);
    const next = state.update(planInsert(state, "paste-abc.png", null)).state;
    expect(next.doc.toString()).toBe("words\n![[paste-abc.png]]\n");
    expect(next.doc.lineAt(next.selection.main.head).number).toBe(3);
  });

  test("the row draws immediately, which is the point of where the caret went", () => {
    const state = stateFor("words", 5);
    const next = state.update(planInsert(state, "paste-abc.png", null)).state;
    const rows = imageRows(next, (range) =>
      selectionTouches(range, [
        { from: next.selection.main.from, to: next.selection.main.to },
      ]),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].line.images[0].target).toBe("paste-abc.png");
  });

  test("a second paste lands under the first, not beside it", () => {
    const state = stateFor("words", 5);
    const once = state.update(planInsert(state, "paste-abc.png", null)).state;
    const twice = once.update(planInsert(once, "paste-def.png", null)).state;
    expect(twice.doc.toString()).toBe("words\n![[paste-abc.png]]\n![[paste-def.png]]\n");
  });

  test("a width is written when the host asked for one", () => {
    const state = stateFor("", 0);
    expect(
      state.update(planInsert(state, "paste-abc.png", 480)).state.doc.toString(),
    ).toBe("![[paste-abc.png|480]]\n");
  });
});

describe("bytes to a src", () => {
  test("base64 matches the platform's own, padding and all", () => {
    for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar", "any ± carnal pleasure"]) {
      const bytes = new TextEncoder().encode(text);
      expect(base64FromBytes(bytes.buffer)).toBe(Buffer.from(text, "utf8").toString("base64"));
    }
  });

  test("every byte value survives, which a naive encoder gets wrong at 0x80", () => {
    const bytes = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) bytes[index] = index;
    expect(base64FromBytes(bytes.buffer)).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("a megabyte does not blow the stack, which a spread would", () => {
    const bytes = new Uint8Array(1_000_000).fill(7);
    expect(base64FromBytes(bytes.buffer).length).toBeGreaterThan(1_300_000);
  });

  test("the src carries the type the store answered with", () => {
    const bytes = new TextEncoder().encode("hi");
    expect(dataUrlFor(bytes.buffer, "image/png")).toBe("data:image/png;base64,aGk=");
  });
});

describe("what a paste offers, and from which list", () => {
  /** A `File` without the DOM's constructor, which jsdom's `DataTransfer` lacks. */
  function file(type: string): File {
    return { type, name: "x", size: 1 } as unknown as File;
  }

  function transfer(options: {
    files?: File[];
    items?: Array<{ kind: string; file: File | null }>;
  }): DataTransfer {
    return {
      files: options.files ?? [],
      items: (options.items ?? []).map((entry) => ({
        kind: entry.kind,
        getAsFile: () => entry.file,
      })),
    } as unknown as DataTransfer;
  }

  test("a drop from the desktop arrives in files", () => {
    const png = file("image/png");
    expect(imageFilesFrom(transfer({ files: [png] }))).toEqual([png]);
  });

  test("a paste that only fills items is still a paste", () => {
    const png = file("image/png");
    expect(imageFilesFrom(transfer({ items: [{ kind: "file", file: png }] }))).toEqual([png]);
  });

  test("a browser that fills both lists does not paste the image twice", () => {
    const png = file("image/png");
    expect(
      imageFilesFrom(transfer({ files: [png], items: [{ kind: "file", file: png }] })),
    ).toEqual([png]);
  });

  test("text on the clipboard is not an image, and neither is a PDF", () => {
    expect(
      imageFilesFrom(
        transfer({
          files: [file("application/pdf")],
          items: [{ kind: "string", file: null }],
        }),
      ),
    ).toEqual([]);
    expect(imageFilesFrom(null)).toEqual([]);
  });
});
