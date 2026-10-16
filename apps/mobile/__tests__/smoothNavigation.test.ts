/**
 * A PAGE ARRIVES WHOLE, OR THE ONE ON SCREEN STAYS.
 *
 * Owner, 2026-10-16, from a screen recording of the phone: "the app flickers a
 * lot, navigating does not feel smooth … make sure before navigating to any
 * page everything in that page is loaded, and we should be preloading the
 * about.md/index.md etc whenever we load a folder." Filmed at 20 frames a
 * second, opening a note from Home went black, then loading bars, then the
 * note's chips with no words, then the note; a folder page showed its raw
 * name, then its title and description, then its status circles, and did all
 * of it again on the way back; and the "Cached copy" pill came and went in the
 * header while the server answered.
 */

import { describe, expect, test } from "@jest/globals";
import { shownEntry } from "../features/console/panes/browsePane/useShownEntry";
import {
  aboutOf,
  cachedBody,
  cachedFolder,
  cachedFront,
  folderPageReady,
  forgetPageCache,
  preloadFolderPage,
  preloadFronts,
  readFolder,
  rememberBody,
  rememberFolder,
  rememberFront,
} from "../features/console/files/folderPage/pageCache";
import type { FolderListSource, ListNote } from "../features/console/files/listBlock/model";
import { scrollFor, rememberScroll } from "../features/console/panes/browsePane/pageScroll";
import { editorReducer, emptyEditor } from "../features/console/files/editor";
import { loudSave, saveChip } from "../features/console/files/status";

function entry(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.split("/").pop()!,
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("shownEntry: what stays on screen", () => {
  const NOTE = entry("1-projects/a.md", "file");
  const FOLDER = entry("1-projects/trip", "folder");
  const PROJECTS = entry("1-projects", "folder");

  test("Home stays while a note opened from it is read", () => {
    // `null` is the page with nothing selected: a phone's Home.
    expect(shownEntry({ target: null, held: null, selectedPath: NOTE.path, opening: NOTE.path, editorPath: null })).toBeNull();
    expect(shownEntry({ target: NOTE, held: null, selectedPath: NOTE.path, opening: NOTE.path, editorPath: null })).toBeNull();
  });

  test("…and gives way the moment the editor holds it", () => {
    expect(shownEntry({ target: NOTE, held: null, selectedPath: NOTE.path, opening: null, editorPath: NOTE.path })).toBe(NOTE);
  });

  test("nothing drawn before holds nothing", () => {
    expect(shownEntry({ target: NOTE, held: undefined, selectedPath: NOTE.path, opening: NOTE.path, editorPath: null })).toBe(NOTE);
  });

  test("a folder page whose reads have not landed keeps the page on screen", () => {
    expect(shownEntry({ target: FOLDER, held: PROJECTS, selectedPath: FOLDER.path, opening: null, editorPath: null, waiting: true })).toBe(PROJECTS);
    expect(shownEntry({ target: FOLDER, held: null, selectedPath: FOLDER.path, opening: null, editorPath: null, waiting: true })).toBeNull();
  });

  test("…and arrives once they have", () => {
    expect(shownEntry({ target: FOLDER, held: PROJECTS, selectedPath: FOLDER.path, opening: null, editorPath: null, waiting: false })).toBe(FOLDER);
  });

  test("going back to Home is never held", () => {
    expect(shownEntry({ target: null, held: FOLDER, selectedPath: null, opening: null, editorPath: null, waiting: true })).toBeNull();
  });
});

function note(path: string, properties: Record<string, string> = {}, heading?: string): ListNote {
  return { path, updatedAt: 1, properties, ...(heading === undefined ? {} : { heading }) } as ListNote;
}

/** A source that answers by hand, counting what it was asked. */
function fakeSource(notes: readonly ListNote[], bodies: Record<string, string>) {
  const asked = { load: 0, loadFront: 0, readBody: 0 };
  const source: FolderListSource = {
    load: async (folder, subfolders) => {
      asked.load += 1;
      const prefix = folder === "" ? "" : `${folder}/`;
      return {
        notes: notes.filter((each) => each.path.startsWith(prefix) && (subfolders || !each.path.slice(prefix.length).includes("/"))),
        complete: true,
      };
    },
    loadFront: async (folders) => {
      asked.loadFront += 1;
      return notes.filter((each) => {
        const parent = each.path.slice(0, each.path.lastIndexOf("/"));
        return folders.includes(parent) && /\/(about|index|README)\.md$/.test(each.path);
      });
    },
    readBody: async (path) => {
      asked.readBody += 1;
      return path in bodies ? { text: bodies[path]!, encrypted: false } : null;
    },
  };
  return { source, asked };
}

describe("pageCache: a folder page's reads, kept and read ahead", () => {
  const NOTES = [
    note("1-projects/about.md", {}, "Projects"),
    note("1-projects/trip/about.md", { status: "finished" }, "October group Airbnb trip"),
    note("1-projects/trip/packing.md", { status: "in progress" }),
    note("1-projects/plain/notes.md"),
  ];
  const BODIES = {
    "1-projects/about.md": "# Projects\n\nActive work with an end.",
    "1-projects/trip/about.md": "# October group Airbnb trip\n\nTwenty-two people, one house.",
  };

  test("a listing's folders are read ahead in one call, each filed under its folder", async () => {
    const { source, asked } = fakeSource(NOTES, BODIES);
    preloadFronts(source, ["1-projects/trip", "1-projects/plain"]);
    await flush();
    await flush();
    expect(asked.loadFront).toBe(1);
    expect(cachedFront(source, "1-projects/trip")?.map((each) => each.path)).toEqual(["1-projects/trip/about.md"]);
    // A folder with no front note is an answer too: the page has nothing to wait for.
    expect(cachedFront(source, "1-projects/plain")).toEqual([]);
    // The front note's words are read with it, since the page draws them under the title.
    expect(cachedBody(source, "1-projects/trip/about.md")).toEqual({ kind: "text", text: BODIES["1-projects/trip/about.md"] });
    // Nothing read twice once it is known.
    preloadFronts(source, ["1-projects/trip"]);
    await flush();
    expect(asked.loadFront).toBe(1);
  });

  test("a page is ready only with its front note, its notes and the front note's words", async () => {
    const { source } = fakeSource(NOTES, BODIES);
    expect(folderPageReady(source, "1-projects/trip")).toBe(false);
    preloadFolderPage(source, "1-projects/trip");
    await flush();
    await flush();
    await flush();
    expect(cachedFolder(source, "1-projects/trip")?.notes.map((each) => each.path)).toContain("1-projects/trip/packing.md");
    expect(folderPageReady(source, "1-projects/trip")).toBe(true);
  });

  test("…the words included: a title over an empty description is the flicker", () => {
    const { source } = fakeSource(NOTES, BODIES);
    rememberFront(source, "1-projects/trip", [NOTES[1]!]);
    rememberFolder(source, "1-projects/trip", { notes: NOTES, complete: true });
    expect(folderPageReady(source, "1-projects/trip")).toBe(false);
    rememberBody(source, "1-projects/trip/about.md", { kind: "text", text: "words" });
    expect(folderPageReady(source, "1-projects/trip")).toBe(true);
  });

  test("Home and a source-less page never wait", () => {
    const { source } = fakeSource(NOTES, BODIES);
    expect(folderPageReady(source, "")).toBe(true);
    expect(folderPageReady(undefined, "1-projects")).toBe(true);
  });

  test("a page and the press that preloaded it share one read", async () => {
    const { source, asked } = fakeSource(NOTES, BODIES);
    const a = readFolder(source, "1-projects/trip");
    const b = readFolder(source, "1-projects/trip");
    await Promise.all([a, b]);
    // One for the folder, one for the root above it (no front notes by name? `loadFront` serves those).
    expect(asked.load).toBe(1);
    // A change reads again rather than answering with the read from before it.
    await readFolder(source, "1-projects/trip", true);
    expect(asked.load).toBe(2);
  });

  test("a front note read with its text is not read a second time for its words", async () => {
    const { source, asked } = fakeSource(NOTES, BODIES);
    const loadFront = source.loadFront!;
    const withText: FolderListSource = {
      ...source,
      loadFront: async (folders) =>
        (await loadFront(folders)).map((each) => ({ ...each, text: BODIES[each.path as keyof typeof BODIES] ?? "" })),
    };
    preloadFronts(withText, ["1-projects/trip"]);
    await flush();
    await flush();
    expect(asked.readBody).toBe(0);
    expect(cachedBody(withText, "1-projects/trip/about.md")).toEqual({ kind: "text", text: BODIES["1-projects/trip/about.md"] });
  });

  test("a source that cannot read front notes by name waits only for the folder's notes", async () => {
    const { source } = fakeSource(NOTES, BODIES);
    const plain: FolderListSource = { load: source.load };
    expect(folderPageReady(plain, "1-projects/trip")).toBe(false);
    await readFolder(plain, "1-projects/trip");
    expect(folderPageReady(plain, "1-projects/trip")).toBe(true);
  });

  test("the front note a page draws its words from", () => {
    expect(aboutOf("1-projects/trip", [note("1-projects/trip/about.md")])).toBe("1-projects/trip/about.md");
    expect(aboutOf("1-projects/plain", [])).toBeNull();
  });

  test("signing out forgets every page, and a read already on its way files nothing", async () => {
    const { source } = fakeSource(NOTES, BODIES);
    await readFolder(source, "1-projects/trip");
    expect(cachedFolder(source, "1-projects/trip")).toBeDefined();
    const late = readFolder(source, "1-projects", true);
    forgetPageCache();
    await late;
    expect(cachedFolder(source, "1-projects/trip")).toBeUndefined();
    expect(cachedFolder(source, "1-projects")).toBeUndefined();
  });

  test("one source's reads are never another's", async () => {
    const one = fakeSource(NOTES, BODIES).source;
    const two = fakeSource([], {}).source;
    preloadFronts(one, ["1-projects/trip"]);
    await flush();
    expect(cachedFront(two, "1-projects/trip")).toBeUndefined();
  });
});

describe("pageScroll: a page gone back to is where it was left", () => {
  test("back restores, forward starts at the top", () => {
    rememberScroll("", 640);
    rememberScroll("1-projects", 300);
    expect(scrollFor("1-projects", "")).toBe(640);
    expect(scrollFor("1-projects/trip", "1-projects")).toBe(300);
    expect(scrollFor("", "1-projects")).toBe(0);
    expect(scrollFor(null, "")).toBe(0);
  });
});

describe("a copy shown while the server is asked is not a warning yet", () => {
  const COPY = {
    path: "1-projects/a.md",
    text: "words",
    etag: "e1",
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };

  test("the phone's header says nothing while the server is asked", () => {
    const early = editorReducer(emptyEditor, { type: "opened", note: COPY, fromCache: true, checking: true });
    const chip = saveChip({ editor: early, now: 0 } as Parameters<typeof saveChip>[0]);
    expect(chip?.tone).toBe("quiet");
    expect(loudSave(chip)).toBeNull();
  });

  test("…and says Cached copy once the server could not answer", () => {
    const early = editorReducer(emptyEditor, { type: "opened", note: COPY, fromCache: true, checking: true });
    const checked = editorReducer(early, { type: "checked", path: COPY.path });
    expect(saveChip({ editor: checked, now: 0 } as Parameters<typeof saveChip>[0])?.text).toBe("Cached copy");
    // A copy shown offline or after a failure says so at once, as before.
    const offline = editorReducer(emptyEditor, { type: "opened", note: COPY, fromCache: true });
    expect(loudSave(saveChip({ editor: offline, now: 0 } as Parameters<typeof saveChip>[0]))?.text).toBe("Cached copy");
  });

  test("the server's answer replaces the copy and the claim", () => {
    const early = editorReducer(emptyEditor, { type: "opened", note: COPY, fromCache: true, checking: true });
    const reloaded = editorReducer(early, { type: "reloaded", note: { ...COPY, etag: "e2" } });
    expect(reloaded.fromCache).toBeUndefined();
    expect(reloaded.checking).toBeUndefined();
  });

  test("a check for another note changes nothing", () => {
    const early = editorReducer(emptyEditor, { type: "opened", note: COPY, fromCache: true, checking: true });
    expect(editorReducer(early, { type: "checked", path: "elsewhere.md" })).toBe(early);
  });
});
