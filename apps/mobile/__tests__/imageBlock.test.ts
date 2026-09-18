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
import { WidgetType } from "@codemirror/view";

import { decorationsFor, markdownLanguage } from "../features/console/files/livePreview";
import {
  ImageRowWidget,
  MIN_IMAGE_WIDTH,
  imageFilesFrom,
  imageRowDecoration,
  imageRows,
  inCode,
  planAlign,
  planAlt,
  planDrop,
  planInsert,
  planRemove,
  planReplace,
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

/** The rows this state would draw. */
function rowsOf(state: EditorState): ImageRow[] {
  return imageRows(state);
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

  /*
    THE ONE PLACE THIS EDITOR DOES NOT REVEAL ITS MARKUP.

    Everywhere else the line the selection is in shows its syntax. An image is
    the exception, and the reason is in `imageRows`: the markup is a filename
    nobody types, and clicking a picture to have it turn into
    `![[paste-971e….png]]` was reported as "really weird" the day it shipped.
  */
  test("the row stays drawn wherever the selection is", () => {
    const doc = "![[a.png|320]]\n\nafter";
    expect(rowsOf(stateFor(doc, 0)).length).toBe(1);
    expect(rowsOf(stateFor(doc, 5)).length).toBe(1);
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

  test("the row draws immediately, and the caret is not on its line", () => {
    const state = stateFor("words", 5);
    const next = state.update(planInsert(state, "paste-abc.png", null)).state;
    const rows = imageRows(next);
    expect(rows.length).toBe(1);
    expect(rows[0].line.images[0].target).toBe("paste-abc.png");
    expect(next.doc.lineAt(next.selection.main.head).from).not.toBe(rows[0].from);
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

  /*
    THE BUG THIS PAIR EXISTS FOR.

    `getAsFile()` mints a NEW `File` object on every call, so the first version
    of this — read both lists, de-duplicate by identity — handed back the same
    screenshot twice, uploaded it twice and wrote two embeds. Reported as
    "images paste twice". The fix is not a better de-duplication: it is that
    `files` is the answer whenever it has one.
  */
  test("a browser that fills both lists pastes the image once", () => {
    const fromFiles = file("image/png");
    const fromItems = file("image/png");
    expect(fromFiles).not.toBe(fromItems);
    expect(
      imageFilesFrom(transfer({ files: [fromFiles], items: [{ kind: "file", file: fromItems }] })),
    ).toEqual([fromFiles]);
  });

  test("two genuinely different images in one drop are both kept", () => {
    const first = file("image/png");
    const second = file("image/jpeg");
    expect(imageFilesFrom(transfer({ files: [first, second] }))).toEqual([first, second]);
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

/**
 * THE WIDGET ITSELF, BUILT.
 *
 * Everything above this line tests a planner: a state in, a transaction out,
 * and not one `ImageRowWidget` constructed. That gap shipped a note screen that
 * threw on load — `WidgetType` has an internal getter-only `editable`, and a
 * field of that name on the subclass is an assignment to it, which in a module
 * (strict by construction) is a `TypeError` in the constructor, before a single
 * pixel. The build was green because no test here had ever reached the `new`.
 *
 * So these go through `decorationsFor` — the real path the editor takes on
 * every transaction — rather than around it.
 */
describe("the row, built", () => {
  /** Every getter `WidgetType` defines with no setter: names a subclass cannot own. */
  function reservedByWidgetType(): string[] {
    const names: string[] = [];
    for (
      let proto: object | null = WidgetType.prototype;
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
        if (descriptor.get !== undefined && descriptor.set === undefined) names.push(name);
      }
    }
    return names;
  }

  /** The widgets a state actually draws, in document order. */
  function widgetsOf(state: EditorState): WidgetType[] {
    const found: WidgetType[] = [];
    decorationsFor(state).between(0, state.doc.length, (_from, _to, value) => {
      const widget = (value.spec as { widget?: WidgetType }).widget;
      if (widget !== undefined) found.push(widget);
    });
    return found;
  }

  const MIXED = "> [!note] Titled\n> body\n\n![[a.png|320]]\n\n- [ ] a task\n";

  test("a note with an image in it can be drawn at all", () => {
    expect(() => widgetsOf(stateFor(MIXED))).not.toThrow();
    expect(widgetsOf(stateFor(MIXED)).some((w) => w instanceof ImageRowWidget)).toBe(true);
  });

  test("a reader who may not write the note gets the row drawn too", () => {
    const state = EditorState.create({
      doc: "![[a.png|320]]\n",
      extensions: [markdownLanguage(), EditorState.readOnly.of(true)],
    });
    expect(() => widgetsOf(state)).not.toThrow();
    expect(widgetsOf(state).some((w) => w instanceof ImageRowWidget)).toBe(true);
  });

  /*
    The guard, and it covers every widget this file's preview draws rather than
    only the image one: `editable` is the name that broke, but `isHidden`,
    `lineBreaks` and `estimatedHeight` are the same trap, and the next widget
    added to `decorationsFor` is checked here without anybody remembering to.
  */
  test("no widget owns a name WidgetType reserves", () => {
    const reserved = reservedByWidgetType();
    expect(reserved).toContain("editable");

    const widgets = widgetsOf(stateFor(MIXED));
    expect(widgets.length).toBeGreaterThan(1);
    for (const widget of widgets) {
      expect(Object.getOwnPropertyNames(widget).filter((n) => reserved.includes(n))).toEqual([]);
      /*
        And the constructor's own text, which is the half the property check
        cannot see. Jest's CommonJS output runs the assignment in sloppy mode,
        where setting a getter-only inherited property is silently dropped
        rather than thrown — so the widget that crashed the browser leaves no
        own property here either, and this test would have stayed green while
        the note screen was down. Reading the source catches it in either mode.
      */
      const source = Function.prototype.toString.call(widget.constructor);
      for (const name of reserved) {
        expect(source).not.toMatch(new RegExp(`this\\.${name}\\s*=[^=]`));
      }
    }
  });

  /*
    The rule itself, so the guard above is anchored to a fact rather than a
    hunch — and written so it holds in the mode the app ships in rather than
    the one Jest happens to run. A module is strict by construction, which is
    why the browser threw where the suite shrugged; `new Function` with the
    directive is the one way to get that mode back inside a sloppy file.
  */
  test("a field named for a WidgetType getter throws where the app runs", () => {
    const setStrictly = new Function("target", '"use strict"; target.editable = true;') as (
      target: object,
    ) => void;
    const widget = new (class extends WidgetType {
      toDOM(): HTMLElement {
        throw new Error("never drawn");
      }
    })();
    expect(() => setStrictly(widget)).toThrow(
      /Cannot set property editable|only a getter|no setter/,
    );
  });

  /*
    And what the name means to CodeMirror, which is the half a rename alone
    would not have caught: `WidgetTile.of` reads `widget.editable` and, finding
    it false, sets `contenteditable="false"` on the row. A widget that answered
    true would hand the reader an image row they could type into.
  */
  test("the drawn row is not editable DOM", () => {
    // `editable` is `@internal` to CodeMirror, so it is read here the way the
    // view reads it rather than through the published type.
    for (const widget of widgetsOf(stateFor(MIXED))) {
      expect((widget as unknown as { editable: boolean }).editable).toBe(false);
    }
  });

  test("a row drawn for a writer is not the same widget as one drawn for a reader", () => {
    const row = imageRows(stateFor("![[a.png|320]]\n"))[0];
    const forWriter = imageRowDecoration(row, null, true, null).spec.widget as ImageRowWidget;
    const forReader = imageRowDecoration(row, null, false, null).spec.widget as ImageRowWidget;
    const selected = imageRowDecoration(row, null, true, { from: row.from, index: 0 }).spec
      .widget as ImageRowWidget;
    expect(forWriter.eq(forWriter)).toBe(true);
    expect(forWriter.eq(forReader)).toBe(false);
    // And a selected image is a different widget from an unselected one, or the
    // toolbar would not appear until something else changed the line.
    expect(forWriter.eq(selected)).toBe(false);
  });
});

describe("what the toolbar writes", () => {
  function rowOf(state: EditorState): ImageRow {
    return imageRows(state)[0];
  }

  test("alt text lands in the alias slot, beside the width", () => {
    const state = stateFor("![[a.png|320]]\n\nx", 16);
    const next = state.update(planAlt(state, rowOf(state), 0, "a sketch")!).state;
    expect(next.doc.toString()).toBe("![[a.png|a sketch|320]]\n\nx");
  });

  test("clearing the alt text takes the alias away again", () => {
    const state = stateFor("![[a.png|a sketch|320]]\n\nx", 25);
    const next = state.update(planAlt(state, rowOf(state), 0, "  ")!).state;
    expect(next.doc.toString()).toBe("![[a.png|320]]\n\nx");
  });

  test("replace keeps the width and swaps the object", () => {
    const state = stateFor("![[a.png|320]] ![[b.png]]\n\nx", 27);
    const next = state.update(planReplace(state, rowOf(state), 0, "c.png")!).state;
    expect(next.doc.toString()).toBe("![[c.png|320]] ![[b.png]]\n\nx");
  });

  test("remove takes one image off a row of two", () => {
    const state = stateFor("![[a.png]] ![[b.png]]\n\nx", 23);
    const next = state.update(planRemove(state, rowOf(state), 0)!).state;
    expect(next.doc.toString()).toBe("![[b.png]]\n\nx");
  });

  test("removing the last image takes the line, not a blank one", () => {
    const state = stateFor("one\n\n![[a.png]]\n\ntwo", 0);
    const next = state.update(planRemove(state, rowOf(state), 0)!).state;
    expect(next.doc.toString()).toBe("one\n\ntwo");
  });

  test("a note that is only an image is left empty rather than holding a blank row", () => {
    const state = stateFor("![[a.png]]", 0);
    const next = state.update(planRemove(state, rowOf(state), 0)!).state;
    expect(next.doc.toString()).toBe("");
  });
});
