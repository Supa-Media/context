/**
 * @jest-environment jsdom
 */

/**
 * FIND-IN-NOTE: THE PANEL, AND THE THREE WAYS OUT OF IT.
 *
 * K2 bound `@codemirror/search` and shipped its stock panel, which was the
 * right first move — the browser's own ⌘F searches only the lines CodeMirror
 * has rendered and silently misses on a long note. What it left is what came
 * back as a report: the panel is CodeMirror's base theme (a `#f5f5f5` strip of
 * unstyled `input`s and `button`s docked under a console painted `#0B0B0D`),
 * and it is only dismissable from inside the editor — Escape at a tree row, a
 * tab or the accessory bar reaches the console's `dismiss` command, which calls
 * `frame.closeOverlays()`, which had never heard of it. ⌘F could not put it
 * away either, because `openSearchPanel` is idempotent.
 *
 * So this file pins a panel of Context's own and the dismissal contract around
 * it. Three of these fail against the stock panel: the toggle, Escape reaching
 * it from outside the editor (through `closeFindPanel`), and the close control
 * having an accessible name.
 *
 * What it still pins, unchanged and for the same reason, is that **native is
 * unaffected**: `findInNote.ts` is reachable from `LiveEditor.web.tsx` and from
 * nothing the iOS guest bundle traces, so `bundle.generated.ts` is byte-
 * identical and `@codemirror/search` never reaches a phone. A custom panel is
 * more code in this module, not a new import in the shared list.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { searchPanelOpen } from "@codemirror/search";
import { closeFindPanel, findInNote } from "../features/console/files/findInNote";
import { BUNDLE_DEPENDENCIES } from "../features/console/files/webview/bundle.generated";

const FILES_DIR = join(__dirname, "..", "features", "console", "files");
const read = (relative: string) => readFileSync(join(FILES_DIR, relative), "utf8");

const NOTE = [
  "# Gateway",
  "",
  "A note lives at 1-projects/gateway.md. The bucket is the boundary,",
  "and the bucket is what gets handed over.",
  "",
  "Bucket, again, with a capital.",
  "",
].join("\n");

interface Mounted {
  view: EditorView;
  parent: HTMLElement;
  /** The find bar, or `null` when it is not open. */
  bar: () => HTMLElement | null;
  field: () => HTMLInputElement;
  count: () => string;
  /** A chord at the caret, exactly as the person presses it. */
  press: (target: HTMLElement, init: KeyboardEventInit) => void;
  unmount: () => void;
}

function mount(doc: string = NOTE): Mounted {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [findInNote()] }),
    parent,
  });

  const bar = () => parent.querySelector<HTMLElement>(".cm-ctx-find");
  return {
    view,
    parent,
    bar,
    field: () => {
      const field = parent.querySelector<HTMLInputElement>(".cm-ctx-find [main-field]");
      if (field === null) throw new Error("the find bar is not open");
      return field;
    },
    count: () => parent.querySelector(".cm-ctx-find-count")?.textContent ?? "",
    press: (target, init) => {
      target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    },
    unmount: () => {
      view.destroy();
      parent.remove();
    },
  };
}

/** Type into the query field the way a person does: value, then the event. */
function type(mounted: Mounted, query: string): void {
  const field = mounted.field();
  field.value = query;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/* -------------------------------------------------------------------------- */

describe("⌘F opens it, and ⌘F puts it away", () => {
  test("the chord opens a find bar against a real, mounted editor", () => {
    const m = mount();
    expect(m.bar()).toBeNull();

    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    expect(m.bar()).not.toBeNull();
    expect(searchPanelOpen(m.view.state)).toBe(true);
    m.unmount();
  });

  /**
   * The half the report was about. `searchKeymap` binds `Mod-f` to
   * `openSearchPanel`, which is idempotent — pressing it again with the bar up
   * refocuses the field and cannot close anything. Ours toggles, and the
   * binding has to win over the stock one for that to be true.
   */
  test("pressing it again with the field focused closes the bar", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });
    const field = m.field();
    expect(document.activeElement).toBe(field);

    m.press(field, { key: "f", ctrlKey: true });

    expect(m.bar()).toBeNull();
    expect(searchPanelOpen(m.view.state)).toBe(false);
    m.unmount();
  });

  /**
   * And the half that must *not* toggle: ⌘F from the document with the bar
   * already open means "put me in the query field", not "close it". Closing
   * there would take the bar away from somebody reaching for it.
   */
  test("pressing it from the note with the bar open focuses the field instead", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });
    type(m, "bucket");
    m.view.contentDOM.focus();

    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    expect(m.bar()).not.toBeNull();
    expect(document.activeElement).toBe(m.field());
    m.unmount();
  });
});

describe("every way out of it", () => {
  test("Escape from the query field", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    m.press(m.field(), { key: "Escape" });

    expect(m.bar()).toBeNull();
    m.unmount();
  });

  test("Escape from the note", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    m.press(m.view.contentDOM, { key: "Escape" });

    expect(m.bar()).toBeNull();
    m.unmount();
  });

  /**
   * The close control. It was a bare `×` in a row of system buttons with no
   * accessible name of its own in the stock panel's markup — `aria-label` is
   * what a screen reader and `getByRole("button", { name })` both read.
   */
  test("the close control, which says what it is", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    const close = m.bar()?.querySelector<HTMLButtonElement>('[aria-label="Close find"]');
    expect(close).not.toBeNull();
    close?.click();

    expect(m.bar()).toBeNull();
    m.unmount();
  });

  /**
   * And that Escape stops here.
   *
   * The console has its own `keydown` listener on `document` (`useKeymap`),
   * where Escape means `dismiss` — the drawer, the rail sheet, whatever else is
   * open behind this bar. A press that the bar itself answered must not go on
   * to close something behind it, so a handled chord has its propagation
   * stopped rather than only its default prevented.
   */
  test("and the press that closed it does not go on to close the console's panels", () => {
    const m = mount();
    const heard: string[] = [];
    const listener = (event: Event) => heard.push((event as KeyboardEvent).key);
    document.addEventListener("keydown", listener);

    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });
    m.press(m.field(), { key: "Escape" });

    expect(m.bar()).toBeNull();
    expect(heard).not.toContain("Escape");

    document.removeEventListener("keydown", listener);
    m.unmount();
  });

  /**
   * THE ONE THE REPORT WAS ACTUALLY ABOUT.
   *
   * `searchKeymap`'s Escape is scoped to `editor` and `search-panel`, so once
   * focus is on a tree row, a tab or the accessory bar the key never reaches
   * the panel at all — it reaches the console's `dismiss` command instead.
   * `closeFindPanel` is what that command can call: it takes the view rather
   * than an event, so the frame's overlay stack can put the bar away from
   * anywhere in the console. It answers whether there was anything to close,
   * because `closeOverlays` returns that boolean and Escape with nothing open
   * must still reach the browser.
   */
  test("closeFindPanel, for an Escape that landed anywhere else in the console", () => {
    const m = mount();
    expect(closeFindPanel(m.view)).toBe(false);

    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });
    // Focus is a tree row now; the editor is not even in the event's path.
    const row = document.createElement("button");
    document.body.appendChild(row);
    row.focus();

    expect(closeFindPanel(m.view)).toBe(true);
    expect(m.bar()).toBeNull();
    expect(closeFindPanel(m.view)).toBe(false);

    row.remove();
    m.unmount();
  });
});

describe("what the bar says while you use it", () => {
  test("the match count, and stepping through matches with Enter", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    type(m, "bucket");
    // Three matches, none of them current until you go to one — "bucket"
    // twice in the third and fourth lines, "Bucket" in the sixth.
    expect(m.count()).toBe("3");

    m.press(m.field(), { key: "Enter" });
    expect(m.count()).toBe("1/3");

    m.press(m.field(), { key: "Enter" });
    expect(m.count()).toBe("2/3");

    // Backwards, and the wrap that comes with it.
    m.press(m.field(), { key: "Enter", shiftKey: true });
    expect(m.count()).toBe("1/3");

    m.unmount();
  });

  test("a query that matches nothing says so in words, not in colour", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    type(m, "prefix tenancy");

    expect(m.count()).toBe("no results");
    m.unmount();
  });

  test("match case is a real toggle, and the count follows it", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });
    type(m, "bucket");
    expect(m.count()).toBe("3");

    const matchCase = m.bar()?.querySelector<HTMLButtonElement>('[aria-label="Match case"]');
    expect(matchCase?.getAttribute("aria-pressed")).toBe("false");
    matchCase?.click();

    expect(matchCase?.getAttribute("aria-pressed")).toBe("true");
    // The capitalised one in the last line is no longer a match.
    expect(m.count()).toBe("2");
    m.unmount();
  });

  test("the query survives a close and reopen, so ⌘F twice is not a wipe", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });
    type(m, "boundary");
    m.press(m.field(), { key: "Escape" });

    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    expect(m.field().value).toBe("boundary");
    m.unmount();
  });
});

describe("the bar lies over the note rather than moving it", () => {
  /**
   * CodeMirror lays a panel container out as a band at the edge of the editor,
   * so a docked bar pushes the note's first line down on open and pulls it back
   * up on close — the line somebody is reading moves because they went looking
   * for a word in it. Ours is absolute, at the top right, over the document.
   *
   * jsdom performs no layout, so this asserts the rule rather than the
   * geometry: that the theme's override actually reaches the container, which
   * is the part that silently would not if CodeMirror's base theme won the
   * cascade.
   */
  test("the panel container is taken out of the layout by the theme", () => {
    const m = mount();
    m.press(m.view.contentDOM, { key: "f", ctrlKey: true });

    const container = m.parent.querySelector<HTMLElement>(".cm-panels");
    expect(container).not.toBeNull();
    const style = window.getComputedStyle(container!);
    expect(style.position).toBe("absolute");
    expect(style.right).toBe("0px");

    m.unmount();
  });
});

describe("the bar is drawn in the app's palette, not the browser's", () => {
  /**
   * Every colour inside the editor is named as an `--lp-*` custom property
   * rather than as a value, because the identical rules run inside the iOS
   * WebView where the palette arrives over a bridge. `liveEditorMount.test.ts`
   * asserts the relationship at the sheet level — every property read is one
   * the host declares. This asserts the other half at the source: a hex in
   * here is a colour that answers to no palette and cannot follow the app from
   * light to dark.
   */
  test("no hardcoded colour in the module", () => {
    const source = read("findInNote.ts");
    const hexes = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes).toEqual([]);
  });

  test("the panel is styled at all — the stock one was not", () => {
    const source = read("findInNote.ts");
    expect(source).toMatch(/EditorView\.theme/);
    expect(source).toMatch(/--lp-/);
  });
});

describe("native is unaffected", () => {
  /**
   * The module's exports, as an allowlist rather than a shape check.
   *
   * It used to be exactly `["findInNote"]`, which said "keymap only to start,
   * no UI of this app's own". The panel *is* that UI now, decided and
   * reviewed — so what the allowlist guards has moved rather than gone: the
   * second export is the closer the frame's Escape needs, and anything else
   * appearing here (a React component, a toolbar key, a touch affordance) is a
   * surface nobody decided on. A touch entry point is still an open decision:
   * `keymap.ts` requires every command to be reachable without a keyboard, and
   * this one is not, which is why it ships to the web alone.
   */
  test("the module exports the extension and its closer, and nothing else", () => {
    const exported = Object.keys(
      require("../features/console/files/findInNote") as Record<string, unknown>,
    );
    expect(exported.sort()).toEqual(["closeFindPanel", "findInNote"]);
  });

  test("editorSetup.ts — compiled into both hosts — never imports @codemirror/search or findInNote", () => {
    const source = read("editorSetup.ts");
    expect(source).not.toMatch(/@codemirror\/search/);
    expect(source).not.toMatch(/findInNote/);
  });

  test("the iOS guest's own entry point and bridge never import findInNote either", () => {
    for (const file of ["webview/entry.ts", "webview/guest.ts", "webview/protocol.ts", "webview/host.ts"]) {
      expect(read(file)).not.toMatch(/findInNote/);
    }
  });

  test("the committed bundle — what actually ships to a phone — was not rebuilt with @codemirror/search in it", () => {
    // This is the artifact `scripts/build-editor-bundle.mjs` produces from
    // `webview/entry.ts`, recorded by `editorBundle.test.ts` as current. If a
    // later change folded `findInNote` into the shared extension list and
    // *did* rebuild the bundle, this is the line that would catch the new
    // dependency landing on iOS.
    expect(Object.keys(BUNDLE_DEPENDENCIES)).not.toContain("@codemirror/search");
  });
});
