/**
 * @jest-environment jsdom
 */
/**
 * Changing a status or an owner from a folder list: the menu a value opens,
 * the row moving group the moment the write lands, and the read-change-write
 * that does it. The one-line frontmatter change itself is
 * `apps/mcp/src/lists/setProperty.js`, proved in
 * `apps/mcp/test/listSetProperty.test.mjs`.
 */

import { beforeAll, describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listHost, type ListHostContext, type ListNote } from "../features/console/files/listBlock/model";
import { valueChoices } from "../features/console/files/listBlock/valueMenu";
import { writeNoteProperty, type NoteReadWrite } from "../features/console/files/listBlock/writeProperty";
import { livePreview, markdownLanguage } from "../features/console/files/livePreview";
import type { OwnerSearch } from "../features/console/files/owners";

const NOTES: ListNote[] = [
  { path: "p/web.md", updatedAt: 3, properties: { status: "active", owner: "Seyi" } },
  { path: "p/app.md", updatedAt: 2, properties: { status: "planned", owner: "Seyi's Codex" } },
  { path: "p/old.md", updatedAt: 1, properties: { status: "done", tags: ["a", "b"] } },
];

const doc = (...lines: string[]) => ["# P", "", "```list", ...lines, "```", ""].join("\n");

beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});

type Call = [path: string, key: string, value: string | null];

function mount(
  text: string,
  options: { writes?: Call[]; answer?: string | null; canWrite?: boolean; searchOwners?: OwnerSearch } = {},
): EditorView {
  const { writes = [], answer = null, canWrite = true, searchOwners } = options;
  const host: ListHostContext = {
    ...(searchOwners === undefined ? {} : { searchOwners }),
    load: async () => ({ notes: NOTES, complete: true }),
    open: () => undefined,
    selfPath: "p/README.md",
    ...(canWrite
      ? {
          setProperty: async (path: string, key: string, value: string | null) => {
            writes.push([path, key, value]);
            return answer;
          },
        }
      : {}),
  };
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({ doc: text, selection: { anchor: 0 }, extensions: [markdownLanguage(), livePreview(), listHost.of({ current: host })] }),
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const menu = (view: EditorView) => view.dom.querySelector<HTMLElement>(".cm-lp-list-menu");
const items = (view: EditorView) => [...view.dom.querySelectorAll(".cm-lp-list-menu-item")].map((node) => node.textContent);
const edits = (view: EditorView) => [...view.dom.querySelectorAll<HTMLButtonElement>(".cm-lp-list-edit")];

describe("changing a value from a list", () => {
  test("a value is a button for someone who can write, and plain text for anyone else", async () => {
    const writer = mount(doc("from: p", "show: owner, updated"));
    const reader = mount(doc("from: p", "show: owner, updated"), { canWrite: false });
    await flush();
    expect(edits(writer).map((b) => b.textContent)).toEqual(["Seyi", "Seyi's Codex", "Set"]);
    expect(edits(reader)).toHaveLength(0);
    // "updated" is when it was saved, not something to set.
    expect(writer.dom.querySelectorAll(".cm-lp-list-value:not(.cm-lp-list-edit)")).toHaveLength(3);
    writer.destroy();
    reader.destroy();
  });

  test("a list-valued property is never offered as one choice", async () => {
    const view = mount(doc("from: p", "show: tags"));
    await flush();
    expect(edits(view).map((b) => b.textContent)).toEqual(["Set", "Set"]);
    view.destroy();
  });

  test("visibility is shown and never offered as a value to change", async () => {
    // Who can read a note is privacy.md's answer, set with Share; see `listBlock/writable.ts`.
    const view = mount(doc("from: p", "show: visibility, owner"));
    await flush();
    expect(edits(view).map((b) => b.textContent)).toEqual(["Seyi", "Seyi's Codex", "Set"]);
    expect(view.dom.querySelectorAll('.cm-lp-list-edit[title="Change visibility"]')).toHaveLength(0);
    view.destroy();
  });

  test("the menu offers the words the list already uses, the current one checked", async () => {
    const view = mount(doc("from: p", "show: status"));
    await flush();
    edits(view)[0].click();
    expect(menu(view)).not.toBeNull();
    expect(items(view)).toEqual(["✓active", "planned", "done", "No status"]);
    expect(edits(view)[0].getAttribute("aria-expanded")).toBe("true");
    view.destroy();
  });

  test("a choice writes that one property of that row's note, and the row moves group at once", async () => {
    const writes: Call[] = [];
    const view = mount(doc("from: p", "group: status", "show: status"), { writes });
    await flush();
    // Status groups run Not started, In progress, Done (apps/mcp/src/lists/statuses.js).
    expect([...view.dom.querySelectorAll(".cm-lp-list-group")].map((g) => g.firstChild?.textContent)).toEqual(["Planned", "Active", "Done"]);
    edits(view)[1].click();
    [...view.dom.querySelectorAll<HTMLElement>(".cm-lp-list-menu-item")][2].click(); // done
    await flush();
    await flush();
    expect(writes).toEqual([["p/web.md", "status", "done"]]);
    expect(menu(view)).toBeNull();
    expect([...view.dom.querySelectorAll(".cm-lp-list-group")].map((g) => g.firstChild?.textContent)).toEqual(["Planned", "Done"]);
    view.destroy();
  });

  test("a new word is typed for a status, and clearing is a choice of its own", async () => {
    const writes: Call[] = [];
    const view = mount(doc("from: p", "show: status"), { writes });
    await flush();
    edits(view)[2].click();
    const field = view.dom.querySelector<HTMLInputElement>(".cm-lp-list-menu-new")!;
    field.value = "  blocked ";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    await flush();
    edits(view)[0].click();
    view.dom.querySelector<HTMLElement>(".cm-lp-list-menu-clear")!.click();
    await flush();
    expect(writes).toEqual([
      ["p/old.md", "status", "  blocked "],
      ["p/web.md", "status", null],
    ]);
    view.destroy();
  });

  test("an owner is picked from people and agents the server finds, never typed", async () => {
    const writes: Call[] = [];
    const asked: string[] = [];
    const searchOwners: OwnerSearch = async (query) => {
      asked.push(query);
      const people = ["Sayo", "Seyi Olujide"].filter((name) => name.toLowerCase().includes(query.toLowerCase()));
      return { people: people.map((value) => ({ value, isMe: false })), agents: ["Claude"], truncated: false };
    };
    const view = mount(doc("from: p", "show: owner"), { writes, searchOwners });
    await flush();
    edits(view)[2].click();
    await flush();
    expect(view.dom.querySelector(".cm-lp-list-menu-new")).toBeNull();
    expect(items(view).map((text) => text?.replace(/[\u2066-\u2069]/g, ""))).toEqual([
      "Sayo",
      "Seyi Olujide",
      "Claude",
      "Any agent · Whichever picks it up",
    ]);
    const field = view.dom.querySelector<HTMLInputElement>(".cm-lp-list-menu-search")!;
    field.value = "sey";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(asked).toEqual(["", "sey"]);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();
    await flush();
    edits(view)[0].click();
    await flush();
    // "Seyi" was typed by hand once: kept, checked and marked; "No owner" clears it.
    expect(items(view)[0]?.replace(/[\u2066-\u2069]/g, "")).toBe("✓Seyi · Not a member");
    view.dom.querySelector<HTMLElement>(".cm-lp-list-menu-clear")!.click();
    await flush();
    expect(writes).toEqual([
      ["p/old.md", "owner", "Seyi Olujide"],
      ["p/web.md", "owner", null],
    ]);
    view.destroy();
  });

  test("a write that did not land says why and keeps the menu open", async () => {
    const view = mount(doc("from: p", "show: owner"), { answer: "That note is changing right now. Try again in a moment." });
    await flush();
    edits(view)[0].click();
    await flush();
    [...view.dom.querySelectorAll<HTMLElement>(".cm-lp-list-menu-item")][1].click();
    await flush();
    expect(menu(view)?.querySelector(".cm-lp-list-menu-problem")?.textContent).toBe(
      "That note is changing right now. Try again in a moment.",
    );
    expect(edits(view)[0].textContent).toBe("Seyi");
    view.destroy();
  });

  test("Escape closes the menu and gives focus back to the value", async () => {
    const view = mount(doc("from: p", "show: owner"));
    await flush();
    edits(view)[0].click();
    menu(view)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu(view)).toBeNull();
    expect(document.activeElement).toBe(edits(view)[0]);
    view.destroy();
  });

  test("choices fold case and run in lifecycle order", () => {
    const notes: ListNote[] = [
      { path: "a.md", properties: { status: "Zeta" } },
      { path: "b.md", properties: { status: "done" } },
      { path: "c.md", properties: { status: "Active" } },
      { path: "d.md", properties: { status: "active" } },
      { path: "e.md", properties: { status: ["x"] } },
    ];
    expect(valueChoices(notes, "status")).toEqual(["Active", "done", "Zeta"]);
  });
});

describe("the read, the change and the write", () => {
  function io(notes: Record<string, { text: string; etag: string; encrypted?: boolean; readOnly?: boolean }>, fail: string[] = []) {
    const written: Array<[string, string, string | undefined]> = [];
    const store: NoteReadWrite = {
      read: async (path) => {
        const note = notes[path];
        if (note === undefined) throw new ConvexError({ code: "NOT_FOUND", message: "gone" });
        return note;
      },
      write: async (path, text, etag) => {
        const code = fail.shift();
        if (code !== undefined) throw new ConvexError({ code, message: code });
        written.push([path, text, etag]);
        return { path };
      },
    };
    return { store, written };
  }
  const note = { text: "---\nstatus: planned\n---\n# X\n", etag: "e1" };

  test("the changed text is written against the version read", async () => {
    const { store, written } = io({ "x.md": note });
    expect(await writeNoteProperty(store, "x.md", "status", "active")).toBeNull();
    expect(written).toEqual([["x.md", "---\nstatus: active\n---\n# X\n", "e1"]]);
  });

  test("a note that moved on is read again once, then the person is told", async () => {
    const once = io({ "x.md": note }, ["CONFLICT"]);
    expect(await writeNoteProperty(once.store, "x.md", "status", "active")).toBeNull();
    expect(once.written).toHaveLength(1);
    const twice = io({ "x.md": note }, ["CONFLICT", "CONFLICT"]);
    expect(await writeNoteProperty(twice.store, "x.md", "status", "active")).toMatch(/changing right now/);
    expect(twice.written).toHaveLength(0);
  });

  test("an encrypted or read-only note is never written", async () => {
    const locked = io({ "x.md": { ...note, encrypted: true }, "y.md": { ...note, readOnly: true } });
    expect(await writeNoteProperty(locked.store, "x.md", "status", "active")).toMatch(/encrypted/);
    expect(await writeNoteProperty(locked.store, "y.md", "status", "active")).toMatch(/not change it/);
    expect(locked.written).toEqual([]);
  });

  test("a value the frontmatter cannot hold is refused with the reason", async () => {
    const { store, written } = io({ "x.md": note });
    expect(await writeNoteProperty(store, "x.md", "status", "a\nb")).toMatch(/one line/);
    expect(written).toEqual([]);
  });

  test("visibility is refused before the note is read, in any case and even as a create", async () => {
    let reads = 0;
    const { store, written } = io({ "x.md": note });
    const counted: NoteReadWrite = { read: (path) => (reads++, store.read(path)), write: store.write };
    for (const key of ["visibility", "Visibility", " VISIBILITY "]) {
      expect(await writeNoteProperty(counted, "x.md", key, "team")).toMatch(/set with Share/);
      expect(await writeNoteProperty(counted, "x.md", key, null)).toMatch(/set with Share/);
      expect(await writeNoteProperty(counted, "p/a/overview.md", key, "private", { create: true })).toMatch(/set with Share/);
    }
    expect(reads).toBe(0);
    expect(written).toEqual([]);
  });

  test("nothing is written when nothing would change", async () => {
    const { store, written } = io({ "x.md": note });
    expect(await writeNoteProperty(store, "x.md", "status", "planned")).toBeNull();
    expect(written).toEqual([]);
  });

  test("a note that cannot be read is said so", async () => {
    const { store } = io({});
    expect(await writeNoteProperty(store, "x.md", "status", "active")).toMatch(/could not be opened/);
  });

  /*
    A folder page setting the first status of a folder with no front note.
    The note is created by the ordinary create — `writeNote` with no version,
    which the server refuses if a note appeared there meanwhile — and holds the
    frontmatter and nothing else.
  */
  describe("creating the note, when asked to", () => {
    function missing(fail: string[] = []) {
      const written: Array<[string, string, string | undefined]> = [];
      let exists: { text: string; etag: string } | null = null;
      const store: NoteReadWrite = {
        read: async () => {
          if (exists === null) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "gone" });
          return exists;
        },
        write: async (path, text, etag) => {
          const code = fail.shift();
          if (code !== undefined) {
            // Somebody else created it between the read and the write.
            exists = { text: "---\nowner: Sayo\n---\n", etag: "theirs" };
            throw new ConvexError({ code, message: code });
          }
          written.push([path, text, etag]);
          return { path };
        },
      };
      return { store, written };
    }

    test("a missing note is written new, with no version, holding only the property", async () => {
      const { store, written } = missing();
      expect(await writeNoteProperty(store, "p/do this/overview.md", "status", "active", { create: true })).toBeNull();
      expect(written).toEqual([["p/do this/overview.md", "---\nstatus: active\n---\n", undefined]]);
    });

    test("without being asked, a missing note is still refused", async () => {
      const { store, written } = missing();
      expect(await writeNoteProperty(store, "p/x.md", "status", "active")).toMatch(/could not be opened/);
      expect(written).toEqual([]);
    });

    test("a note that appeared meanwhile is read and changed, never replaced", async () => {
      const { store, written } = missing(["CONFLICT"]);
      expect(await writeNoteProperty(store, "p/a/overview.md", "status", "active", { create: true })).toBeNull();
      expect(written).toEqual([["p/a/overview.md", "---\nowner: Sayo\nstatus: active\n---\n", "theirs"]]);
    });

    test("clearing a property of a note that does not exist writes nothing", async () => {
      const { store, written } = missing();
      expect(await writeNoteProperty(store, "p/a/overview.md", "status", null, { create: true })).toBeNull();
      expect(written).toEqual([]);
    });
  });
});
