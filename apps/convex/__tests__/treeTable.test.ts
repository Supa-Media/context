/**
 * A tree drawn from the tree table is the tree a walk of the bucket draws.
 *
 * The table holds keys, never a decision about who may see them: the console
 * hands the unchanged `syncManifest` a store whose `list` reads the table
 * (`treeListingStore`), and every privacy call is still `canSee` over the live
 * `privacy.md`. So the property is equality, at every clearance, page by page,
 * against real SQL (`node:sqlite`, the engine D1 runs) — and a stale row the
 * table still holds is filtered exactly as a live key would be.
 */

import { createRequire } from "node:module";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { type FileStore, setFolderVisibility, setVisibility, syncManifest } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";
import { treeListingStore } from "../../mcp/src/tree/source.js";

// Through `require`: Vite cannot resolve the `node:sqlite` builtin as an import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");
const NAMED = clearanceOf("team", ["ada"]);

function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  return {
    async query(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
    },
    async runAll(statements: readonly { sql: string; params?: unknown[] }[]) {
      db.exec("BEGIN");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...(params as never[]));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return { applied: statements.length, skipped: false };
    },
  };
}

async function workspace(): Promise<MemoryStore & FileStore> {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/launch.md", "# Launch\n");
  store.seed("1-projects/launch/brief.md", "# Brief\n");
  store.seed("1-projects/held-back.md", "# Held back\n");
  store.seed("1-projects/private/plan.md", "# Plan\n");
  store.seed("1-projectsX/sibling.md", "# Not under 1-projects\n");
  store.seed("2-areas/health/vitals.md", "# Vitals\n");
  store.seed(".context/reads/2026-10-08/1.json", "{}");
  for (let index = 0; index < 30; index += 1) {
    store.seed(`3-resources/r${String(index).padStart(2, "0")}.md`, `# R${index}\n`);
  }
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "3-resources", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/held-back.md", visibility: "private", clearance: OWNER });
  return store;
}

/** Every page of a manifest, joined: what a client that follows the cursor holds. */
async function wholeManifest(store: FileStore, clearance: ReturnType<typeof clearanceOf>, pageEntries?: number) {
  const entries = [];
  const folders = new Map<string, unknown>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const manifest = await syncManifest(store, { clearance, ...(cursor ? { cursor } : {}), ...(pageEntries ? { pageEntries } : {}) });
    entries.push(...manifest.entries);
    for (const folder of manifest.folders) folders.set(folder.path, folder.visibility);
    expect(manifest.truncated).toBe(false);
    if (manifest.cursor === null) return { entries, folders: [...folders.entries()] };
    cursor = manifest.cursor;
  }
  throw new Error("the walk did not finish");
}

describe("a tree from the table", () => {
  let store: MemoryStore & FileStore;
  let client: ReturnType<typeof sqliteClient>;

  beforeEach(async () => {
    store = await workspace();
    client = sqliteClient();
    expect((await sweepTreePass(store, client)).complete).toBe(true);
  });

  for (const [name, clearance] of [["the owner", OWNER], ["a member", TEAM], ["a member granted by name", NAMED]] as const) {
    test(`is the bucket's tree for ${name}, page by page`, async () => {
      for (const pageEntries of [undefined, 3]) {
        const fromBucket = await wholeManifest(store, clearance, pageEntries);
        for (const pageRows of [undefined, 4]) {
          const table = treeListingStore(store, client, pageRows ? { pageRows } : {}) as FileStore;
          expect(await wholeManifest(table, clearance, pageEntries)).toEqual(fromBucket);
        }
      }
    });
  }

  test("a member never receives a private note's row, the table holding it or not", async () => {
    const member = await wholeManifest(treeListingStore(store, client) as FileStore, TEAM);
    const text = JSON.stringify(member);
    expect(text).not.toContain("held-back");
    expect(text).not.toContain("1-projects/private");
    expect(text).not.toContain("vitals");
    expect(text).not.toContain(".context");
    expect(member.entries.map((entry) => entry.path)).toContain("1-projects/launch/brief.md");
  });

  test("a row the bucket no longer holds is still judged by privacy.md, never shown wider", async () => {
    // Made private after the sweep: the table is not told, and need not be.
    await setVisibility(store, { path: "1-projects/launch.md", visibility: "private", clearance: OWNER });
    // And a private note deleted from the bucket, its row left behind.
    await store.delete("2-areas/health/vitals.md");
    const member = await wholeManifest(treeListingStore(store, client) as FileStore, TEAM);
    const paths = member.entries.map((entry) => entry.path);
    expect(paths).not.toContain("1-projects/launch.md");
    expect(JSON.stringify(member)).not.toContain("vitals");
  });

  test("the table is read, not the bucket", async () => {
    const list = vi.spyOn(store, "list");
    await wholeManifest(treeListingStore(store, client) as FileStore, OWNER);
    expect(list).not.toHaveBeenCalled();
  });
});
