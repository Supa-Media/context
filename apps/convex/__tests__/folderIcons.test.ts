/**
 * Folder icons (`lib/fileOps/folderIcons.ts`, `@context/shared`'s
 * `folderIcons.cjs`): set from a folder's menu, kept in the workspace's own
 * bucket, read back only for folders the reader can see, and carried along
 * when a folder moves.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  archivePath,
  deletePath,
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  movePath,
  setFolderVisibility,
} from "../functions/lib/fileOps";
import { listFolderIcons, setFolderIcon } from "../functions/lib/fileOps/folderIcons";
import { FOLDER_ICONS_KEY, parseFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");
const MEMBER = clearanceOf("team");

function bucket(): MemoryStore & FileStore {
  const store = memoryStore({}) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (const folder of ["1-projects", "2-areas", "9-archive", "recipes", "secret"]) {
    store.seed(`${folder}/README.md`, `# ${folder}\n`);
  }
  store.seed("recipes/soups/leek.md", "# Leek\n");
  return store;
}

function stored(store: MemoryStore): Record<string, string> {
  const text = store.snapshot()[FOLDER_ICONS_KEY];
  return parseFolderIcons(typeof text === "string" ? text : undefined);
}

async function refusal(fn: () => Promise<unknown>): Promise<FileOpError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof FileOpError) return error;
    throw error;
  }
  throw new Error("Expected the operation to be refused, but it went ahead.");
}

describe("setting a folder icon", () => {
  test("is saved in the workspace's own bucket and read back", async () => {
    const store = bucket();
    expect(await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER })).toEqual({ recipes: "🍳" });
    expect(stored(store)).toEqual({ recipes: "🍳" });
    expect(await listFolderIcons(store, { clearance: OWNER })).toEqual({ recipes: "🍳" });
  });

  test("a built-in folder can have one too: they are still folders", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "1-projects/", icon: "🚀", clearance: OWNER });
    expect(stored(store)).toEqual({ "1-projects": "🚀" });
  });

  test("null removes it, and removing one that is not there is fine", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    expect(await setFolderIcon(store, { path: "recipes", icon: null, clearance: OWNER })).toEqual({});
    expect(await setFolderIcon(store, { path: "recipes", icon: null, clearance: OWNER })).toEqual({});
    expect(stored(store)).toEqual({});
  });

  test.each(["recipes", "🍳🍳", "a", "‮🍳", ""])("refuses %j, which is not one emoji", async (icon) => {
    const store = bucket();
    const error = await refusal(() => setFolderIcon(store, { path: "recipes", icon, clearance: OWNER }));
    expect(error.code).toBe("PATH_INVALID");
    expect(store.snapshot()[FOLDER_ICONS_KEY]).toBeUndefined();
  });

  test.each(["", "/", ".context", ".context/trash", "recipes/../secret"])("refuses the path %j", async (path) => {
    const store = bucket();
    const error = await refusal(() => setFolderIcon(store, { path, icon: "🍳", clearance: OWNER }));
    expect(error.code).toBe("PATH_INVALID");
  });

  test("a folder that does not exist answers not found", async () => {
    const store = bucket();
    const error = await refusal(() => setFolderIcon(store, { path: "nowhere", icon: "🍳", clearance: OWNER }));
    expect(error.code).toBe("FILE_NOT_FOUND");
  });
});

describe("a reader sees only the icons of folders they can see", () => {
  test("a member never learns a private folder's name from its icon", async () => {
    const store = bucket();
    await setFolderVisibility(store, { path: "recipes", visibility: "team", clearance: OWNER });
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    await setFolderIcon(store, { path: "secret", icon: "⚖️", clearance: OWNER });
    expect(await listFolderIcons(store, { clearance: OWNER })).toEqual({ recipes: "🍳", secret: "⚖️" });
    expect(await listFolderIcons(store, { clearance: MEMBER })).toEqual({ recipes: "🍳" });
  });

  test("setting one on a folder the caller cannot see answers exactly as a folder that does not exist", async () => {
    const store = bucket();
    const hidden = await refusal(() => setFolderIcon(store, { path: "secret", icon: "🍳", clearance: MEMBER }));
    const missing = await refusal(() => setFolderIcon(store, { path: "nowhere", icon: "🍳", clearance: MEMBER }));
    expect([hidden.code, hidden.message]).toEqual([missing.code, missing.message]);
    expect(store.snapshot()[FOLDER_ICONS_KEY]).toBeUndefined();
  });

  test("a member's write keeps the icons they cannot see", async () => {
    const store = bucket();
    await setFolderVisibility(store, { path: "recipes", visibility: "team", clearance: OWNER });
    await setFolderIcon(store, { path: "secret", icon: "⚖️", clearance: OWNER });
    expect(await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: MEMBER })).toEqual({ recipes: "🍳" });
    expect(stored(store)).toEqual({ recipes: "🍳", secret: "⚖️" });
  });

  test("a hand-broken file reads as no icons, never an error", async () => {
    const store = bucket();
    store.seed(FOLDER_ICONS_KEY, "{ not json");
    expect(await listFolderIcons(store, { clearance: OWNER })).toEqual({});
    store.seed(FOLDER_ICONS_KEY, JSON.stringify({ version: 1, icons: { recipes: "🍳", "../x": "🍳", ".context": "🍳", soups: 7 } }));
    expect(await listFolderIcons(store, { clearance: OWNER })).toEqual({ recipes: "🍳" });
  });
});

describe("icons follow their folders", () => {
  test("a rename carries the folder's icon and the icons inside it", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    await setFolderIcon(store, { path: "recipes/soups", icon: "🥣", clearance: OWNER });
    await movePath(store, { from: "recipes", to: "2-areas/cooking", clearance: OWNER, now: NOW });
    expect(stored(store)).toEqual({ "2-areas/cooking": "🍳", "2-areas/cooking/soups": "🥣" });
  });

  test("archiving a folder takes its icon into the archive", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    const archived = await archivePath(store, { path: "recipes", clearance: OWNER, now: NOW });
    const icons = stored(store);
    expect(Object.values(icons)).toEqual(["🍳"]);
    expect(Object.keys(icons)[0]).toMatch(/^9-archive\/.+\/recipes$/);
    expect(archived.paths.every((path) => path.startsWith("9-archive/"))).toBe(true);
  });

  test("moving a note leaves the icons alone", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    await movePath(store, { from: "recipes/soups/leek.md", to: "recipes/leek.md", clearance: OWNER, now: NOW });
    expect(stored(store)).toEqual({ recipes: "🍳" });
  });

  test("deleting a folder for good forgets its icons", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    await setFolderIcon(store, { path: "recipes/soups", icon: "🥣", clearance: OWNER });
    await setFolderIcon(store, { path: "2-areas", icon: "🏠", clearance: OWNER });
    await deletePath(store, { path: "recipes", confirmation: DELETE_CONFIRMATION, clearance: OWNER });
    expect(stored(store)).toEqual({ "2-areas": "🏠" });
  });

  test("a move still succeeds when the icon file cannot be written", async () => {
    const store = bucket();
    await setFolderIcon(store, { path: "recipes", icon: "🍳", clearance: OWNER });
    const put = store.put.bind(store);
    store.put = (async (key: string, ...rest: Parameters<typeof put> extends [string, ...infer R] ? R : never) => {
      if (key === FOLDER_ICONS_KEY) throw new Error("bucket said no");
      return await put(key, ...rest);
    }) as typeof store.put;
    const moved = await movePath(store, { from: "recipes", to: "cooking", clearance: OWNER, now: NOW });
    expect(moved.to).toBe("cooking");
    expect(store.snapshot()["cooking/soups/leek.md"]).toBeDefined();
  });
});
