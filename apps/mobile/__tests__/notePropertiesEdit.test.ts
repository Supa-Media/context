/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * Changing a note's properties from the Properties panel.
 *
 * The panel used to be a reader with an inert "Add property — from a desktop,
 * for now" row, and on a desktop the YAML is hidden in the editor until the
 * caret finds it — so in practice nobody could change a property. These mount
 * the real `NoteEditor` (the editor itself stubbed, as `noteProperties.test.ts`
 * explains) and read what reaches `onChange`, because what matters is the file
 * that gets saved: one line changed, every other byte where it was.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits, and reverted.
 *
 * 1. **`propertyRows` marking every row editable** — 3 failed: the list and
 *    nested child, the file's visibility line, and the repeated key.
 * 2. **`changeProperty` ignoring `adding`** — "adding a name the note already
 *    has" fails: the add row overwrote `status` off screen.
 * 3. **`onSet` passed when the note is not editable** — "somebody who can only
 *    read" fails.
 * 4. **The phone path handing the setter the body instead of the whole
 *    note** — "on a phone too" fails: the frontmatter was written into the
 *    body.
 */

jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: () => null,
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
const { propertyRows, changeProperty } =
  require("../features/console/files/noteEditor/propertyEdit") as typeof import("../features/console/files/noteEditor/propertyEdit");
const { parseWebsitePage } =
  require("../../../packages/shared/src/websiteMetadata") as typeof import("../../../packages/shared/src/websiteMetadata");
const { properties, splitNote } =
  require("../features/console/files/frontmatter") as typeof import("../features/console/files/frontmatter");

type EditorState = import("../features/console/files/editor").EditorState;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE = [
  "---",
  "title: Website capabilities lab",
  'description: "A private scratch page: Markdown, HTML, CSS."',
  "audience: public",
  "draft: true",
  "nav: 99",
  "tags:",
  "  - site",
  "team:",
  "  owner: Bo",
  "visibility: private",
  "updated: 2026-09-24",
  "---",
  "",
  "# Lab",
  "",
  "draft: not frontmatter",
  "",
].join("\n");

/** Dev's own lab page, in the shape `parseWebsitePage` accepts. */
const WEBSITE_PAGE = [
  "---",
  "title: Website capabilities lab",
  "description: A private scratch page.",
  "audience: public",
  "draft: true",
  "nav: 99",
  "updated: 2026-09-24",
  "---",
  "",
  "# Lab",
  "",
].join("\n");

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const TEAM = { visibility: "team", inherited: "team", exception: false, readOnly: false } as const;

function mount(
  width: number,
  {
    canEdit = true,
    draft = FILE,
    visibility,
    presence,
  }: { canEdit?: boolean; draft?: string; visibility?: typeof TEAM; presence?: unknown } = {},
) {
  const changes: string[] = [];
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 956, configurable: true });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  let state: EditorState = { ...emptyEditor, status: "clean", path: "website/lab.md", baseline: draft, draft };
  const render = () =>
    root.render(
      createElement(NoteEditor, {
        state,
        canEdit,
        visibility,
        presence: presence as never,
        onChange: (text: string) => {
          changes.push(text);
          // The parent's reducer, reduced to the part the panel reads back.
          state = { ...state, status: "dirty", draft: text };
          render();
        },
        onSave: jest.fn() as () => void,
        onDiscard: jest.fn() as () => void,
        onUseTheirs: jest.fn() as () => void,
        onKeepMine: jest.fn() as () => void,
      }),
    );
  act(render);

  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const press = (node: HTMLElement | null) => {
    if (node === null) throw new Error("nothing to press");
    act(() => {
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const type = (testId: string, text: string) => {
    const input = find(testId) as HTMLInputElement | HTMLTextAreaElement | null;
    if (input === null) throw new Error(`no field ${testId}`);
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    act(() => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const key = (testId: string, name: string) => {
    const input = find(testId);
    if (input === null) throw new Error(`no field ${testId}`);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    });
  };
  press(find("note-properties"));
  return { changes, find, press, type, key, latest: () => changes.at(-1) };
}

describe("changing a value", () => {
  test("pressing a value, typing and pressing Enter changes that one line", () => {
    const app = mount(1440);
    app.press(app.find("note-property-audience-value"));
    app.type("note-property-audience-input", "members");
    app.key("note-property-audience-input", "Enter");

    expect(app.changes).toEqual([FILE.replace("audience: public", "audience: members")]);
    // The row shows the new value, back at rest.
    expect(app.find("note-property-audience-input")).toBeNull();
    expect(app.find("note-properties-open")!.textContent).toContain("members");
  });

  /*
    A website page takes `draft` and `nav` only bare, so the first version of
    this — which wrote `draft: "false"` — turned a page into a problem the
    moment somebody published it from here.
  */
  test("true, false and numbers are written bare, and a website page still parses", () => {
    const app = mount(1440, { draft: WEBSITE_PAGE });
    app.press(app.find("note-property-draft-value"));
    app.type("note-property-draft-input", "false");
    app.key("note-property-draft-input", "Enter");
    app.press(app.find("note-property-nav-value"));
    app.type("note-property-nav-input", "2");
    app.key("note-property-nav-input", "Enter");
    app.press(app.find("note-property-audience-value"));
    app.type("note-property-audience-input", "members");
    app.key("note-property-audience-input", "Enter");
    const page = WEBSITE_PAGE.replace("draft: true", "draft: false").replace("nav: 99", "nav: 2").replace("audience: public", "audience: members");
    expect(app.latest()).toBe(page);
    const parsed = parseWebsitePage(page);
    expect([parsed.draft, parsed.nav, parsed.audience, parsed.problems]).toEqual([false, 2, "members", []]);
  });

  test("a value YAML would misread as another type keeps its quotes", () => {
    const app = mount(1440);
    app.press(app.find("note-property-nav-value"));
    app.type("note-property-nav-input", "yes");
    app.key("note-property-nav-input", "Enter");
    expect(app.latest()).toBe(FILE.replace("nav: 99", 'nav: "yes"'));
  });

  test("Escape puts it back and writes nothing", () => {
    const app = mount(1440);
    app.press(app.find("note-property-nav-value"));
    app.type("note-property-nav-input", "3");
    app.key("note-property-nav-input", "Escape");
    expect(app.changes).toEqual([]);
    expect(app.find("note-property-nav-input")).toBeNull();
  });

  test("a cleared value is backed out of, not saved as empty", () => {
    const app = mount(1440);
    app.press(app.find("note-property-nav-value"));
    app.type("note-property-nav-input", "  ");
    app.key("note-property-nav-input", "Enter");
    expect(app.changes).toEqual([]);
  });

  test("a line break or a comment is refused with the reason, and nothing is written", () => {
    const app = mount(1440);
    app.press(app.find("note-property-nav-value"));
    app.type("note-property-nav-input", "room #4");
    app.key("note-property-nav-input", "Enter");
    expect(app.changes).toEqual([]);
    expect(app.find("note-properties-problem")!.textContent).toMatch(/comment/);
  });
});

describe("removing and adding", () => {
  test("× removes the property's line and only that line", () => {
    const app = mount(1440);
    app.press(app.find("note-property-nav-remove"));
    expect(app.changes).toEqual([FILE.replace("nav: 99\n", "")]);
  });

  test("Add property takes a name and a value and adds them as the last line", () => {
    const app = mount(1440);
    app.press(app.find("note-properties-add"));
    app.type("note-properties-add-name", "status");
    app.type("note-properties-add-value", "active");
    app.key("note-properties-add-value", "Enter");
    expect(app.changes).toEqual([FILE.replace("updated: 2026-09-24\n---", "updated: 2026-09-24\nstatus: active\n---")]);
    expect(app.find("note-properties-adding")).toBeNull();
  });

  test("the add row's × backs out without writing anything", () => {
    const app = mount(1440);
    app.press(app.find("note-properties-add"));
    app.type("note-properties-add-name", "status");
    app.press(app.find("note-properties-add-cancel"));
    expect(app.changes).toEqual([]);
    expect(app.find("note-properties-adding")).toBeNull();
    expect(app.find("note-properties-add")).not.toBeNull();
  });

  test("adding a name the note already has is refused rather than overwriting it", () => {
    const app = mount(1440);
    app.press(app.find("note-properties-add"));
    app.type("note-properties-add-name", "audience");
    app.type("note-properties-add-value", "members");
    app.key("note-properties-add-value", "Enter");
    expect(app.changes).toEqual([]);
    expect(app.find("note-properties-problem")!.textContent).toMatch(/already has audience/);
  });

  test("a note with no frontmatter gets one on a phone, where the panel is always drawn", () => {
    const plain = "# Plain\n\nText\n";
    const app = mount(390, { draft: plain, visibility: TEAM });
    app.press(app.find("note-properties-add"));
    app.type("note-properties-add-name", "status");
    app.type("note-properties-add-value", "active");
    app.key("note-properties-add-value", "Enter");
    expect(app.latest()).toBe("---\nstatus: active\n---\n\n# Plain\n\nText\n");
  });
});

describe("what stays read-only", () => {
  test("a list and a nested map's child are shown, and not offered for editing", () => {
    const app = mount(1440);
    expect(app.find("note-properties-open")!.textContent).toContain("owner");
    expect(app.find("note-property-tags-value")).toBeNull();
    expect(app.find("note-property-owner-value")).toBeNull();
    expect(app.find("note-property-team-value")).toBeNull();
  });

  test("the file's visibility line is not a property you can set here", () => {
    const app = mount(1440);
    expect(app.find("note-property-visibility-value")).toBeNull();
    app.press(app.find("note-properties-add"));
    app.type("note-properties-add-name", "visibility");
    app.type("note-properties-add-value", "team");
    app.key("note-properties-add-value", "Enter");
    expect(app.changes).toEqual([]);
    expect(app.find("note-properties-problem")!.textContent).toMatch(/Share/);
  });

  test("somebody who can only read gets the values and no controls", () => {
    const app = mount(1440, { canEdit: false });
    expect(app.find("note-properties-open")!.textContent).toContain("Website capabilities lab");
    expect(app.find("note-property-title-value")).toBeNull();
    expect(app.find("note-properties-add")).toBeNull();
  });
});

describe("on a phone too", () => {
  test("the change is made to the whole note, not to the body the editor holds", () => {
    const app = mount(390);
    app.press(app.find("note-property-title-value"));
    app.type("note-property-title-input", "Lab");
    app.key("note-property-title-input", "Enter");
    expect(app.latest()).toBe(FILE.replace("title: Website capabilities lab", "title: Lab"));
  });
});

describe("in a note people are editing together", () => {
  test("the change merges against the snapshot it was read from, not over the live text", () => {
    const versioned: [string, string][] = [];
    const plain: string[] = [];
    const collaboration = {
      ready: true,
      text: FILE,
      revision: "SNAPSHOT",
      onChange: (text: string) => plain.push(text),
      onVersionedChange: (text: string, base: string) => void versioned.push([text, base]),
    };
    const app = mount(1440, { presence: { summary: "", members: [], collaboration } });
    app.press(app.find("note-property-nav-value"));
    app.type("note-property-nav-input", "3");
    app.key("note-property-nav-input", "Enter");
    expect(versioned).toEqual([[FILE.replace("nav: 99", "nav: 3"), "SNAPSHOT"]]);
    expect(plain).toEqual([]);
  });
});

describe("propertyRows agrees with the reader it annotates", () => {
  test.each([
    ["the lab note", FILE],
    ["CRLF", "---\r\na: 1\r\nb: two\r\n---\r\n"],
    ["a repeated key", "---\nstatus: a\nstatus: b\n---\n"],
    ["quotes and colons", "---\nurl: \"https://example.invalid/a:b\"\nc: he said \"no\"\n---\n"],
  ])("%s: the same rows, in the same order", (_name, file) => {
    const { frontmatter } = splitNote(file);
    expect(propertyRows(frontmatter).map(({ key, value }) => ({ key, value }))).toEqual(properties(frontmatter));
  });

  test("only the last of a repeated key is editable, the one both sides read", () => {
    const rows = propertyRows(splitNote("---\nstatus: a\nstatus: b\n---\n").frontmatter);
    expect(rows.map((row) => row.editable)).toEqual([false, true]);
  });

  test("changeProperty never touches the body", () => {
    const changed = changeProperty(FILE, "draft", "false");
    expect("text" in changed && changed.text.endsWith("draft: not frontmatter\n")).toBe(true);
  });
});
