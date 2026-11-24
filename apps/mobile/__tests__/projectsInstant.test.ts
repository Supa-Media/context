/**
 * A PROJECT'S PAGE OPENS AT ONCE.
 *
 * Owner, 2026-11-24, after the Areas page was made instant: "you didnt work on
 * making the project details load instantly as well?". A project's page waited
 * for its notes, its front notes and its about.md's words on every first open.
 * Then: "the descriptions on pages still take their time to load". Now the
 * Projects folder is read ahead, and every folder's description under it
 * (`preloadProjects`, `preloadWords`), so `folderPageReady` holds before a click.
 *
 * Sabotage, confirmed: dropping `preloadWords` fails "every project's page is
 * ready…" (the descriptions are not there).
 */

import { describe, expect, test } from "@jest/globals";
import { cachedBody, folderPageReady, forgetPageCache } from "../features/console/files/folderPage/pageCache";
import { foldersUnder, preloadProjects, PRELOAD_WORDS } from "../features/console/files/folderPage/preloadProjects";
import type { FolderListSource, ListNote } from "../features/console/files/listBlock/model";
import { folderListSource } from "../features/offline/folderListSource";

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function note(path: string, text?: string): ListNote {
  return { path, updatedAt: 1, properties: {}, heading: null, lede: null, ...(text === undefined ? {} : { text }) };
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function fakeSource(notes: ListNote[]) {
  const asked = { load: [] as string[], fronts: [] as string[][], readBody: [] as string[] };
  const source: FolderListSource = {
    load: async (folder, subfolders) => {
      asked.load.push(folder);
      const prefix = folder === "" ? "" : `${folder}/`;
      return { notes: notes.filter((each) => each.path.startsWith(prefix) && (subfolders || !each.path.slice(prefix.length).includes("/"))), complete: true };
    },
    // As the server's: front notes by folder, with their text.
    loadFront: async (folders) => {
      asked.fronts.push([...folders]);
      return notes.filter((each) => folders.includes(parentOf(each.path)) && each.path.endsWith("/about.md")).map((each) => ({ ...each, text: `# ${each.path}` }));
    },
    readBody: async (path) => {
      asked.readBody.push(path);
      return { text: `# ${path}`, encrypted: false };
    },
  };
  return { source, asked };
}

describe("preloadProjects", () => {
  test("every project's page is ready before it is opened, description included", async () => {
    forgetPageCache();
    const { source, asked } = fakeSource([
      note("projects/about.md"),
      note("projects/alpha/about.md"),
      note("projects/alpha/plan.md"),
      note("projects/beta/about.md"),
      note("projects/beta/deep/about.md"),
      note("projects/loose.md"),
      note("projects/gamma/notes.md"),
    ]);
    preloadProjects(source, "projects");
    await flush();
    for (const project of ["projects/alpha", "projects/beta", "projects/beta/deep", "projects/gamma"]) expect(folderPageReady(source, project)).toBe(true);
    expect(cachedBody(source, "projects/alpha/about.md")).toEqual({ kind: "text", text: "# projects/alpha/about.md" });
    expect(asked.load).toEqual(["projects"]);
    // The root's own came with its front notes.
    expect(asked.readBody.sort()).toEqual(["projects/alpha/about.md", "projects/beta/about.md", "projects/beta/deep/about.md"]);
  });

  test("a large Projects folder reads a bounded number of descriptions", async () => {
    forgetPageCache();
    const many = Array.from({ length: PRELOAD_WORDS + 15 }, (_, i) => note(`projects/p${i}/about.md`));
    const { source, asked } = fakeSource(many);
    preloadProjects(source, "projects");
    await flush();
    expect(asked.readBody.filter((path) => path.startsWith("projects/p")).length).toBe(PRELOAD_WORDS);
  });

  test("names every folder under the root, nearest first", () => {
    expect(foldersUnder("projects", ["projects/a/b/y.md", "projects/a/x.md", "projects/top.md", "other/c/z.md"])).toEqual(["projects/a", "projects/a/b"]);
  });
});

describe("folderListSource's quick reads", () => {
  const base = {
    readNote: async (path: string) => ({ kind: "file", path, text: `slow ${path}`, etag: "e", visibility: "team", inherited: "team", exception: false, readOnly: false, encrypted: false }) as never,
    readNotes: async (paths: string[]) => paths.map((path) => ({ path, outcome: "read", note: { text: `slow ${path}`, encrypted: false } })) as never,
    folderNotes: async () => ({ available: true, notes: [], cursor: null, missing: [] }),
    writeNote: async (path: string) => ({ path }),
  };
  const make = (io: Record<string, unknown>) =>
    folderListSource({ workspaceId: "w", scope: "team", canEdit: false, io: { ...base, ...io } as never, openMirror: async () => null, needed: async () => () => new Set(), online: () => true });

  test("a description is read the quick way, and the slow way where the quick one has no answer", async () => {
    expect(await make({ peekNote: async () => ({ text: "quick", encrypted: false }) }).readBody!("a/about.md")).toEqual({ text: "quick", encrypted: false });
    expect(await make({ peekNote: async () => null }).readBody!("a/about.md")).toEqual({ text: "slow a/about.md", encrypted: false });
    expect(await make({ peekNote: async () => Promise.reject(new Error("down")) }).readBody!("a/about.md")).toEqual({ text: "slow a/about.md", encrypted: false });
  });

  test("front notes are read the quick way, and the slow way where the quick one has no answer", async () => {
    const quick = [note("a/about.md")];
    expect(await make({ frontNotes: async () => quick }).loadFront!(["a"])).toBe(quick);
    const slow = await make({ frontNotes: async () => null }).loadFront!(["a"]);
    expect(slow.map((each) => each.path)).toContain("a/about.md");
  });
});
