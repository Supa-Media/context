/**
 * Folder icons (`lib/fileOps/folderIcons.ts`, `lib/smallData/icons.ts`,
 * `@context/shared`'s `folderIcons.cjs`): held in Convex since 2026-10-14,
 * read back only for folders the reader can see, carried along when a folder
 * moves, and written to the bucket's file without it ever being read back.
 * The actions end to end are `files/smallData.test.ts`.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Keyed workspaces only: the icon file is no longer the record, so a move or
 * trash of a plain store is not a case here (`KEYED_WORKSPACE`).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - `remapIcons` ignoring `store.folderIconsHeld` (the file is read and
 *    written instead): "a move changes the rows and never reads the file";
 *  - `folderVisibleAtScope` swapped for "every icon": "a member never learns
 *    a private folder's name from its icon".
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { FileOpError, type FileStore, loadPrivacyState } from "../functions/lib/fileOps";
import { checkFolderIcon, visibleFolderIcons } from "../functions/lib/fileOps/folderIcons";
import { FOLDER_ICONS_KEY, parseFolderIcons, serializeFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { attachSmallData } from "../functions/lib/smallData/attach";
import { PRIVACY_KEY } from "../functions/lib/privacy";
// A workspace laid out before the numbers were dropped (2026-10-21): its folders keep them.
import { LEGACY_PARA_FOLDERS } from "../functions/lib/scaffold";
import { start } from "./nodes/moveFixture.helpers";
import { keyedFixture } from "./nodes/keyedFixture.helpers";
import { setFolderVisibility, setVisibility, renderPrivacyManifestForFolders } from "./seededRules.helpers";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");
const MEMBER = clearanceOf("team");

function bucket(): MemoryStore & FileStore {
  const store = memoryStore({}) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifestForFolders(LEGACY_PARA_FOLDERS));
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

/** `checkFolderIcon` over a bucket standing in for the tree, with the emoji named in `emoji`. */
async function check(
  store: MemoryStore & FileStore,
  options: { path: string; icon: string | null; clearance: ReturnType<typeof clearanceOf>; emoji?: string[] },
): Promise<string> {
  return await checkFolderIcon({
    path: options.path,
    icon: options.icon,
    clearance: options.clearance,
    state: await loadPrivacyState(store),
    tree: store,
    hasEmoji: async (name) => (options.emoji ?? []).includes(name),
  });
}

describe("who may set an icon, and where", () => {
  test("a folder, a built-in folder and a note may each have one", async () => {
    const store = bucket();
    expect(await check(store, { path: "recipes", icon: "🍳", clearance: OWNER })).toBe("recipes");
    expect(await check(store, { path: "1-projects/", icon: "🚀", clearance: OWNER })).toBe("1-projects");
    expect(await check(store, { path: "recipes/soups/leek.md", icon: "🥬", clearance: OWNER })).toBe("recipes/soups/leek.md");
  });

  test.each(["recipes", "🍳🍳", "a", "\u202e🍳", ""])("refuses %j, which is not one emoji", async (icon) => {
    const error = await refusal(() => check(bucket(), { path: "recipes", icon, clearance: OWNER }));
    expect(error.code).toBe("PATH_INVALID");
  });

  test.each(["", "/", ".context", ".context/trash", "recipes/../secret"])("refuses the path %j", async (path) => {
    const error = await refusal(() => check(bucket(), { path, icon: "🍳", clearance: OWNER }));
    expect(error.code).toBe("PATH_INVALID");
  });

  test("one of the workspace's own emoji is allowed as its :name:, and only one Convex holds", async () => {
    const store = bucket();
    expect(await check(store, { path: "recipes", icon: ":party-parrot:", clearance: OWNER, emoji: ["party-parrot"] })).toBe("recipes");
    const error = await refusal(() => check(store, { path: "recipes", icon: ":nobody-made-this:", clearance: OWNER }));
    expect(error.code).toBe("PATH_INVALID");
  });

  test("one of Context's own icons is allowed by a name in the set (owner, 2026-10-21)", async () => {
    const store = bucket();
    expect(await check(store, { path: "recipes", icon: "context:icon:utensils", clearance: OWNER })).toBe("recipes");
    expect(await check(store, { path: "recipes/soups/leek.md", icon: "context:icon:leaf", clearance: OWNER })).toBe("recipes/soups/leek.md");
  });

  test.each(["context:icon:nope", "context:icon:", "context:icon:constructor", "context:part:tex_skills", "context:tex", "context:job:inbox"])(
    "refuses %j, which is no Context icon anybody can choose",
    async (icon) => {
      const error = await refusal(() => check(bucket(), { path: "recipes", icon, clearance: OWNER }));
      expect(error.code).toBe("PATH_INVALID");
    },
  );

  test.each([":Party:", "::", ":a:b:", ":../x:", " :x: "])("refuses %j, which is not a workspace emoji's name", async (icon) => {
    const error = await refusal(() => check(bucket(), { path: "recipes", icon, clearance: OWNER, emoji: ["x"] }));
    expect(error.code).toBe("PATH_INVALID");
  });

  test("a folder or note the tree does not hold answers not found; removing one is always fine", async () => {
    const store = bucket();
    expect((await refusal(() => check(store, { path: "nowhere", icon: "🍳", clearance: OWNER }))).code).toBe("FILE_NOT_FOUND");
    expect((await refusal(() => check(store, { path: "recipes/nothing.md", icon: "🥬", clearance: OWNER }))).code).toBe(
      "FILE_NOT_FOUND",
    );
    expect(await check(store, { path: "nowhere", icon: null, clearance: OWNER })).toBe("nowhere");
  });

  test("a folder the caller cannot see answers exactly as one that does not exist", async () => {
    const store = bucket();
    const hidden = await refusal(() => check(store, { path: "secret", icon: "🍳", clearance: MEMBER }));
    const missing = await refusal(() => check(store, { path: "nowhere", icon: "🍳", clearance: MEMBER }));
    expect([hidden.code, hidden.message]).toEqual([missing.code, missing.message]);
  });

  test("a note held back inside a folder the member can see answers as a missing note", async () => {
    const store = bucket();
    store.seed("recipes/held.md", "# Held\n");
    await setFolderVisibility(store, { path: "recipes", visibility: "team", clearance: OWNER });
    await setVisibility(store, { path: "recipes/held.md", visibility: "private", clearance: OWNER });
    const hidden = await refusal(() => check(store, { path: "recipes/held.md", icon: "🍳", clearance: MEMBER }));
    const missing = await refusal(() => check(store, { path: "recipes/nowhere.md", icon: "🍳", clearance: MEMBER }));
    expect([hidden.code, hidden.message]).toEqual([missing.code, missing.message]);
  });
});

describe("a reader sees only the icons of folders they can see", () => {
  test("a member never learns a private folder's name from its icon", async () => {
    const store = bucket();
    await setFolderVisibility(store, { path: "recipes", visibility: "team", clearance: OWNER });
    const state = await loadPrivacyState(store);
    const icons = { recipes: "🍳", secret: "⚖️" };
    expect(visibleFolderIcons(icons, { clearance: OWNER, state })).toEqual(icons);
    expect(visibleFolderIcons(icons, { clearance: MEMBER, state })).toEqual({ recipes: "🍳" });
  });

  test("a member never sees the icon of a note held back inside a folder they can see", async () => {
    const store = bucket();
    store.seed("recipes/held.md", "# Held\n");
    await setFolderVisibility(store, { path: "recipes", visibility: "team", clearance: OWNER });
    await setVisibility(store, { path: "recipes/held.md", visibility: "private", clearance: OWNER });
    const state = await loadPrivacyState(store);
    const icons = { "recipes/soups/leek.md": "🥬", "recipes/held.md": "🤫" };
    expect(visibleFolderIcons(icons, { clearance: MEMBER, state })).toEqual({ "recipes/soups/leek.md": "🥬" });
  });
});

describe("with the control plane, the rows are the record and the file is never read", () => {
  /** A keyed workspace (`keyedFixture`) with icons held in rows; the icons file says something else, and a read of it fails the test. */
  async function held() {
    const f = await keyedFixture();
    attachSmallData(f.ctx, f.ws, f.store);
    f.store.seed(FOLDER_ICONS_KEY, serializeFolderIcons({ "1-projects/launch": "🧨" }));
    const get = f.store.get.bind(f.store);
    f.store.get = (async (key: string, ...rest: unknown[]) => {
      if (key === FOLDER_ICONS_KEY) throw new Error("the icons file was read back");
      return await (get as (...args: unknown[]) => unknown)(key, ...rest);
    }) as typeof f.store.get;
    const rows = async () =>
      Object.fromEntries(
        (await f.t.query(internal.functions.smallData.icons, { workspaceId: f.ws })).map(({ path, icon }) => [path, icon]),
      );
    const setIcon = (path: string, icon: string) =>
      f.t.mutation(internal.functions.smallData.setIcon, { workspaceId: f.ws, path, icon });
    return { ...f, rows, setIcon };
  }

  test("a move changes the rows and never reads the file", async () => {
    const h = await held();
    await h.setIcon("1-projects/launch", "🚀");
    await h.setIcon("1-projects/launch/sub/deep.md", "🥬");
    await start(h, "1-projects/launch", "3-resources/launch");
    expect(await h.rows()).toEqual({ "3-resources/launch": "🚀", "3-resources/launch/sub/deep.md": "🥬" });
    // The file is the sync's to write; the move left it alone.
    expect(stored(h.store)).toEqual({ "1-projects/launch": "🧨" });
  });

  test("a change to the rows owes the file a write", async () => {
    const h = await held();
    await h.setIcon("1-projects/launch", "🚀");
    const snapshot = await h.t.query(internal.functions.smallData.snapshot, { workspaceId: h.ws });
    expect(snapshot.icons?.icons).toEqual([{ path: "1-projects/launch", icon: "🚀" }]);
  });
});
