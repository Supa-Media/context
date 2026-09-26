/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number.

  Every screen now clears them through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero. Mocking the hook is the same trade
  `appFrameRender.test.ts` makes: the insets are the platform's business, and a
  provider here would be a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The note's frontmatter, folded away — and the file, unchanged underneath.
 *
 * `frontmatter.test.ts` pins the split as a pure function: `frontmatter + body`
 * is `source` for every input it is given. That is necessary and not
 * sufficient. The property that matters to somebody's bucket is about the
 * *component*: that a note opened on a phone, typed into and saved comes back
 * as the file it was, with its YAML byte for byte where it started.
 *
 * A pure test cannot see that, because the place it can go wrong is the wiring
 * — `NoteEditor` hands the editor a body and has to put the block back in front
 * of every edit before it reaches `onChange`. Drop that one concatenation and
 * every captured note in the product silently loses its provenance on the first
 * save, with nothing on screen to say so and every unit test still green. So
 * this mounts the real component and reads what it actually passes upward.
 *
 * The fixture is a real captured email's block, trimmed: it is the shape that
 * motivated the whole change, and it carries the two cases a naive parser gets
 * wrong — a value with colons in it (an ISO timestamp) and a `subject` that is
 * the note's actual name while its filename is a content hash.
 */

/**
 * The editor is stubbed, and that is the point of this file rather than a
 * shortcut past it.
 *
 * What is being pinned is a contract between two components: `NoteEditor` hands
 * the editor a *body* and has to put the block back in front of whatever comes
 * out. Driving the real editor to produce that "whatever" means typing into
 * CodeMirror's contenteditable under jsdom, which tests CodeMirror's DOM
 * handling far more than it tests the concatenation — and would go green if the
 * concatenation were deleted and the stub simply echoed the whole file back.
 *
 * So the stub records the props it is given, and each test sends an edit back
 * up through the real `onChange` the component built. The assertion is then
 * about the one thing that can lose somebody's data.
 */
let lastProps: { value: string; onChange: (text: string) => void } | null = null;
jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: { value: string; onChange: (text: string) => void }) => {
    lastProps = props;
    return null;
  },
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { noteHeading, splitNote } =
  require("../features/console/files/frontmatter") as typeof import("../features/console/files/frontmatter");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATH = "0-inbox/email/3efac11d4eead8832e5b1236.md";

const FRONTMATTER = [
  "---",
  'captured: "2026-08-29T02:51:47.360Z"',
  'source: "email"',
  "status: unprocessed",
  'subject: "Re: the storage binding"',
  'sender: "someone@example.com"',
  "---",
].join("\n");

const BODY = ["", "# Notes", "", "The first paragraph of the note itself.", ""].join("\n");

const FILE = `${FRONTMATTER}\n${BODY}`;

function stateFor(over: Partial<EditorState> = {}): EditorState {
  return { ...emptyEditor, status: "clean", path: PATH, baseline: FILE, draft: FILE, ...over };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  lastProps = null;
});

/**
 * A phone, mounted for real.
 *
 * react-native-web measures `document.documentElement.clientWidth`, which jsdom
 * reports as 0 — the trap `appFrameRender.test.ts` documents at length. Without
 * the stub every density reads as `compact` by accident, which would make this
 * whole file pass for the wrong reason.
 */
function mountEditor(width: number, state: EditorState = stateFor()) {
  const changes: string[] = [];

  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 956,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(NoteEditor, {
        state,
        canEdit: true,
        onChange: (text: string) => changes.push(text),
        onSave: jest.fn() as () => void,
        onDiscard: jest.fn() as () => void,
        onUseTheirs: jest.fn() as () => void,
        onKeepMine: jest.fn() as () => void,
      }),
    );
  });

  const find = (testId: string) =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  return {
    container,
    changes,
    find,
    /** What the editor was handed, and the way to send an edit back up. */
    editor: () => {
      if (lastProps === null) throw new Error("the editor was never rendered");
      return lastProps;
    },
    press: (node: HTMLElement | null) => {
      if (node === null) throw new Error("nothing to press");
      act(() => {
        node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    },
  };
}

/* -------------------------------------------------------------------------- */

describe("the file is never altered by being displayed", () => {
  /**
   * The one that would cost somebody their data.
   *
   * The editor is handed the body; what leaves it has to be the whole file
   * again. If this fails, every captured note loses its `captured:`, `source:`
   * and `sender:` lines the first time anybody fixes a typo on their phone.
   */
  test("an edit made on a phone comes back with the frontmatter in front of it", () => {
    const app = mountEditor(390);

    act(() => {
      app.editor().onChange(`${app.editor().value}Typed on a train.`);
    });

    expect(app.changes).toHaveLength(1);
    expect(app.changes[0]).toBe(`${FILE}Typed on a train.`);
    expect(app.changes[0]!.startsWith(FRONTMATTER)).toBe(true);
  });

  /**
   * And an edit that changes nothing changes nothing.
   *
   * Re-emitting the body exactly reassembles the original file, character for
   * character — so opening a note, touching it and putting it back cannot
   * rewrite a line ending or drop a trailing newline. This is the assertion
   * that would catch a "helpful" trim added to either half.
   */
  test("a no-op edit reassembles the original bytes", () => {
    const app = mountEditor(390);

    act(() => {
      app.editor().onChange(app.editor().value);
    });

    expect(app.changes[0]).toBe(FILE);
  });

  /**
   * The same property over the awkward shapes, through the component.
   *
   * `frontmatter.test.ts` proves `splitNote` round-trips these; this proves the
   * *wiring* does, which is a different claim — a CRLF file reassembled by a
   * component that trimmed one side would fail here and pass there.
   */
  test.each([
    ["CRLF line endings", "---\r\nx: 1\r\n---\r\nbody\r\n"],
    ["an unterminated block", "---\nx: 1\nstill going\n"],
    ["an empty block", "---\n---\nbody\n"],
    ["a body full of horizontal rules", "---\nx: 1\n---\n\nfirst\n\n---\n\nsecond\n"],
    ["no trailing newline", "---\nx: 1\n---\nbody"],
  ])("a no-op edit on a note with %s changes nothing", (_name, file) => {
    const app = mountEditor(390, stateFor({ baseline: file, draft: file }));

    act(() => {
      app.editor().onChange(app.editor().value);
    });

    expect(app.changes[0]).toBe(file);
  });

  /** A note with no frontmatter is passed through untouched, prefix and all. */
  test("a note with no frontmatter is handed to the editor whole", () => {
    const plain = "# Just a note\n\nNothing filed about it.\n";
    const app = mountEditor(390, stateFor({ baseline: plain, draft: plain }));
    expect(app.editor().value).toBe(plain);
    // The row is still drawn on a phone, for the access map alone — see
    // "the access-map row is the phone's" below.
    expect(app.find("note-properties-open")).toBeNull();
  });
});

describe("what is shown instead", () => {
  test("the YAML is off the first screen, and the note is on it", () => {
    const app = mountEditor(390);

    expect(app.editor().value).toBe(splitNote(FILE).body);
    expect(app.editor().value).not.toContain("captured:");
    expect(app.editor().value).toContain("The first paragraph of the note itself.");
  });

  test("a collapsed row says how many fields there are", () => {
    const app = mountEditor(390);
    const row = app.find("note-properties");
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe("5 properties");
    // Collapsed is the resting state: the whole complaint being answered is
    // that this metadata was taking the reader's first screen.
    expect(app.find("note-properties-open")).toBeNull();
  });

  test("pressing it shows the fields, values and all", () => {
    const app = mountEditor(390);
    app.press(app.find("note-properties"));

    const open = app.find("note-properties-open");
    expect(open).not.toBeNull();
    expect(open!.textContent).toContain("captured");
    expect(open!.textContent).toContain("2026-08-29T02:51:47.360Z");
    expect(open!.textContent).toContain("Re: the storage binding");
    // The quotes are YAML's syntax, not part of what the note says.
    expect(open!.textContent).not.toContain('"email"');
  });

  /**
   * **A desktop does the same thing, and this reverses what it used to.**
   *
   * The case this replaces read "a desktop is unchanged — the editor still
   * holds the whole file", on the argument that the window is wide enough for
   * a dozen lines of YAML not to be the screen and that `livePreview.ts`
   * already dims a frontmatter block in place.
   *
   * Both halves were true and the conclusion still did not hold. Measured in
   * Chromium at 1440×900 against the console's own demo note: the first thing
   * on the page was `---`, `updated: 2026-08-26`, `status: active`, `---` in a
   * dim mono block, *above* the note's own title — four lines of filing before
   * the first word anybody wrote. Dimmed is not the same as out of the way,
   * and the design draws a page whose first line is its title.
   *
   * What answers it is a pair, and the halves are deliberately not the same
   * as the phone's:
   *
   *  - this panel is drawn here too, so a reader is told *what is filed*;
   *  - and `livePreview.ts` hides the block in the editor until the caret is
   *    in it, so it is out of the way while you read and there the moment you
   *    go to it.
   *
   * **The editor still holds the whole file at this density, and that is the
   * point of the pair.** The panel edits one line at a time, and only the
   * lines it can draw faithfully (`notePropertiesEdit.test.ts`); a list or a
   * nested map is still the editor's, and handing it the body here would take
   * those away on the only surface that has them.
   */
  test("a desktop folds it the same way, and the editor still holds the file", () => {
    const app = mountEditor(1440);
    expect(app.find("note-properties")).not.toBeNull();
    // The block is hidden by the editor's own decorations rather than removed
    // from its buffer; `livePreview.test.ts` is where that is asserted.
    expect(app.editor().value).toBe(FILE);
  });

  test("and a note with nothing filed on it gets no row at either width", () => {
    /*
      An empty disclosure is worse than no disclosure. The one case where a
      pointer layout and a phone differ is the *access map*: a phone's
      breadcrumb carries no visibility chip, so that answer is a row in here
      and the panel is drawn for it alone; a pointer layout says it one line
      above the editor and a second copy would be the same answer twice. This
      harness passes no `visibility`, so what it can hold is the shared half —
      nothing filed, nothing drawn.
    */
    const plain = "# Just a note\n\nNothing filed about it.\n";
    for (const width of [390, 1440]) {
      const app = mountEditor(width, stateFor({ baseline: plain, draft: plain }));
      expect(`${width}: ${app.find("note-properties") === null}`).toBe(`${width}: true`);
    }
  });
});

describe("what the note is called", () => {
  /**
   * The complaint that started this: the one line on a phone naming what is on
   * screen was reading `3efac11d4eead8832e5b1236.md`.
   */
  test("a captured note is named by its subject, not by its content hash", () => {
    expect(noteHeading(FILE, PATH)).toBe("Re: the storage binding");
  });

  test("without one, the body's own heading names it", () => {
    const noSubject = FILE.replace('subject: "Re: the storage binding"\n', "");
    expect(noteHeading(noSubject, PATH)).toBe("Notes");
  });

  test("and with neither, the filename does — without its extension", () => {
    expect(noteHeading("Just prose.\n", PATH)).toBe("3efac11d4eead8832e5b1236");
  });
});
