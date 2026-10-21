/**
 * Folder icons (`lib/fileOps/folderIcons.ts`, `lib/smallData/icons.ts`,
 * `@context/shared`'s `folderIcons.cjs`): held in Convex since 2026-10-14,
 * read back only for folders the reader can see, carried along when a folder
 * moves, and written to the bucket's file without it ever being read back.
 * The actions end to end are `files/smallData.test.ts`.
 *
 * Every value here is obviously fake. This repository is public.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - `remapIcons` ignoring `store.folderIconsHeld` (the file is read and
 *    written instead): "a move changes the rows and never reads the file";
 *  - `folderVisibleAtScope` swapped for "every icon": "a member never learns
 *    a private folder's name from its icon".
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "../schema";
import { modules } from "../test.setup";
import { internal } from "../_generated/api";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  archivePath,
  deletePath,
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  loadPrivacyState,
  movePath,
  setFolderVisibility,
  setVisibility,
} from "../functions/lib/fileOps";
import { checkFolderIcon, visibleFolderIcons } from "../functions/lib/fileOps/folderIcons";
import { FOLDER_ICONS_KEY, parseFolderIcons, serializeFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { attachSmallData } from "../functions/lib/smallData/attach";
import { PRIVACY_KEY } from "../functions/lib/privacy";
// A workspace laid out before the numbers were dropped (2026-10-21): its folders keep them.
import { LEGACY_PARA_FOLDERS, renderPrivacyManifestForFolders } from "../functions/lib/scaffold";
import { bridge } from "./nodes/moveFixture.helpers";

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

describe("with no control plane, the file is the record (a self-hosted gateway, a test stub)", () => {
  const seeded = (icons: Record<string, string>) => {
    const store = bucket();
    store.seed(FOLDER_ICONS_KEY, serializeFolderIcons(icons));
    return store;
  };

  test("a rename carries the folder's icon and the icons inside it", async () => {
    const store = seeded({ recipes: "🍳", "recipes/soups": "🥣" });
    await movePath(store, { from: "recipes", to: "2-areas/cooking", clearance: OWNER, now: NOW });
    expect(stored(store)).toEqual({ "2-areas/cooking": "🍳", "2-areas/cooking/soups": "🥣" });
  });

  test("archiving a folder takes its icon into the archive", async () => {
    const store = seeded({ recipes: "🍳" });
    const archived = await archivePath(store, { path: "recipes", clearance: OWNER, now: NOW });
    const icons = stored(store);
    expect(Object.values(icons)).toEqual(["🍳"]);
    expect(Object.keys(icons)[0]).toBe("9-archive/recipes");
    expect(archived.paths.every((path) => path.startsWith("9-archive/"))).toBe(true);
  });

  test("moving a note carries its own icon and leaves the folders' alone", async () => {
    const store = seeded({ recipes: "🍳", "recipes/soups/leek.md": "🥬" });
    await movePath(store, { from: "recipes/soups/leek.md", to: "recipes/leek.md", clearance: OWNER, now: NOW });
    expect(stored(store)).toEqual({ recipes: "🍳", "recipes/leek.md": "🥬" });
  });

  test("deleting a folder for good forgets its icons", async () => {
    const store = seeded({ recipes: "🍳", "recipes/soups": "🥣", "2-areas": "🏠" });
    await deletePath(store, { path: "recipes", confirmation: DELETE_CONFIRMATION, clearance: OWNER });
    expect(stored(store)).toEqual({ "2-areas": "🏠" });
  });

  test("a move still succeeds when the icon file cannot be written", async () => {
    const store = seeded({ recipes: "🍳" });
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

describe("with the control plane, the rows are the record and the file is never read", () => {
  async function held() {
    const t = convexTest(schema, modules);
    const workspaceId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "owner@example.test" } as never);
      return await ctx.db.insert("workspaces", {
        slug: "acme",
        displayName: "Acme",
        createdBy: userId,
        kind: "shared",
        structureTemplate: "para",
        createdAt: NOW,
        updatedAt: NOW,
      });
    });
    const store = bucket();
    // A file that says something else, and a read of it that would fail the test.
    store.seed(FOLDER_ICONS_KEY, serializeFolderIcons({ recipes: "🧨" }));
    const get = store.get.bind(store);
    store.get = (async (key: string, ...rest: unknown[]) => {
      if (key === FOLDER_ICONS_KEY) throw new Error("the icons file was read back");
      return await (get as (...args: unknown[]) => unknown)(key, ...rest);
    }) as typeof store.get;
    attachSmallData(bridge(t), workspaceId, store);
    const rows = async () =>
      Object.fromEntries(
        (await t.query(internal.functions.smallData.icons, { workspaceId })).map(({ path, icon }) => [path, icon]),
      );
    return { t, workspaceId, store, rows };
  }

  test("a move changes the rows and never reads the file", async () => {
    const h = await held();
    await h.t.mutation(internal.functions.smallData.setIcon, { workspaceId: h.workspaceId, path: "recipes", icon: "🍳" });
    await h.t.mutation(internal.functions.smallData.setIcon, {
      workspaceId: h.workspaceId,
      path: "recipes/soups/leek.md",
      icon: "🥬",
    });
    await movePath(h.store, { from: "recipes", to: "2-areas/cooking", clearance: OWNER, now: NOW });
    expect(await h.rows()).toEqual({ "2-areas/cooking": "🍳", "2-areas/cooking/soups/leek.md": "🥬" });
    // The file is the sync's to write; the move left it alone.
    expect(stored(h.store)).toEqual({ recipes: "🧨" });
  });

  test("deleting a note for good forgets its icon in the rows", async () => {
    const h = await held();
    await h.t.mutation(internal.functions.smallData.setIcon, {
      workspaceId: h.workspaceId,
      path: "recipes/soups/leek.md",
      icon: "🥬",
    });
    await h.t.mutation(internal.functions.smallData.setIcon, { workspaceId: h.workspaceId, path: "recipes", icon: "🍳" });
    await deletePath(h.store, { path: "recipes/soups/leek.md", confirmation: DELETE_CONFIRMATION, clearance: OWNER });
    expect(await h.rows()).toEqual({ recipes: "🍳" });
  });

  test("a change to the rows owes the file a write", async () => {
    const h = await held();
    await h.t.mutation(internal.functions.smallData.setIcon, { workspaceId: h.workspaceId, path: "recipes", icon: "🍳" });
    const snapshot = await h.t.query(internal.functions.smallData.snapshot, { workspaceId: h.workspaceId });
    expect(snapshot.icons?.icons).toEqual([{ path: "recipes", icon: "🍳" }]);
  });
});
