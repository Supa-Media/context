/**
 * A FOLDER LIST READ FROM THE TREE'S PROPERTIES TABLE SAYS WHAT THE BUCKET SAYS,
 * AND NOTHING THE READER MAY NOT SEE.
 *
 * Decided by the owner, 2026-10-09: front matter is stored beside the tree so a
 * project Board is one query (`apps/mcp/src/tree/props.js`). The table holds
 * no visibility, so `folderNotesFromTable` must put every row through `canSee`
 * before using it, and must never serve a row parsed at an older version.
 *
 * Sabotage-checked: dropping the `canSee` filter fails "a team reader is never
 * handed a private note"; serving stale rows as they are fails "an edit the
 * table missed is read again".
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, setFolderVisibility, setVisibility } from "../functions/lib/fileOps";
import { folderNotesFromTable, STALE_READ_CAP } from "../functions/lib/filesFns/folderNotes";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";
import { propFillPass } from "../../mcp/src/tree/props.js";
import { touchTree } from "../../mcp/src/tree/touch.js";

// Through `require`: Vite cannot resolve the `node:sqlite` builtin as an import.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

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

type Bucket = MemoryStore & FileStore;
type Client = ReturnType<typeof sqliteClient>;
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function workspace(): Promise<Bucket> {
  const store = memoryStore() as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/about.md", "---\nstatuses: [todo, doing, done]\n---\n# Projects\n");
  store.seed("1-projects/alpha/overview.md", "---\nstatus: doing\nowner: \"@seyi\"\n---\n# Alpha\n\nShip the alpha.\n");
  store.seed("1-projects/alpha/task-one.md", "---\nstatus: done\n---\n# Task one\n");
  store.seed("1-projects/beta/overview.md", "---\nstatus: todo\n---\n# Beta\n");
  store.seed("1-projects/pay.md", "---\nstatus: secret\n---\n# Pay\n\nsalaries\n");
  store.seed("1-projects/.hidden/x.md", "---\nstatus: plumbing\n---\n");
  store.seed("1-projects/locked.md", "---\ncontext_encryption: v1\n---\n\nciphertext\n");
  store.seed("1-projects/picture.png", "png");
  store.seed("2-areas/area.md", "---\nstatus: other\n---\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  return store;
}

async function filled(store: Bucket): Promise<Client> {
  const client = sqliteClient();
  while (!(await sweepTreePass(store, client)).complete);
  for (let pass = 0; pass < 20; pass += 1) if ((await propFillPass(store, client)).ready) return client;
  throw new Error("the properties table never filled");
}

function byPath(result: Awaited<ReturnType<typeof folderNotesFromTable>>) {
  return Object.fromEntries(result.notes.map((note) => [note.path, JSON.parse(note.props)]));
}

function countingGets(store: Bucket): string[] {
  const gets: string[] = [];
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    gets.push(key);
    return get(key);
  };
  return gets;
}

describe("folder notes from the properties table", () => {
  test("the folder's notes with their front matter, heading and first paragraph, read from no note", async () => {
    const store = await workspace();
    const client = await filled(store);
    const gets = countingGets(store);
    const result = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: true }, OWNER);
    expect(result.available).toBe(true);
    const notes = byPath(result);
    expect(Object.keys(notes).sort()).toEqual([
      "1-projects/about.md",
      "1-projects/alpha/overview.md",
      "1-projects/alpha/task-one.md",
      "1-projects/beta/overview.md",
      "1-projects/pay.md",
    ]);
    expect(notes["1-projects/alpha/overview.md"]).toEqual({
      properties: { status: "doing", owner: "@seyi" },
      heading: "Alpha",
      lede: "Ship the alpha.",
    });
    // privacy.md only: no note was opened.
    expect(gets).toEqual([PRIVACY_KEY]);
    expect(result.missing).toEqual([]);
  });

  test("a team reader is never handed a private note, its path or its values", async () => {
    const store = await workspace();
    const client = await filled(store);
    const result = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: true }, TEAM);
    expect(Object.keys(byPath(result))).not.toContain("1-projects/pay.md");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("pay.md");
  });

  test("a folder the reader cannot see answers as an empty one", async () => {
    const store = await workspace();
    const client = await filled(store);
    const result = await folderNotesFromTable(store, client, { folder: "2-areas", subfolders: true }, TEAM);
    expect(result).toMatchObject({ available: true, notes: [], missing: [] });
  });

  test("without subfolders, only the folder's own notes; never plumbing, attachments or encrypted notes", async () => {
    const store = await workspace();
    const client = await filled(store);
    const result = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: false }, OWNER);
    expect(Object.keys(byPath(result)).sort()).toEqual(["1-projects/about.md", "1-projects/pay.md"]);
  });

  test("an edit the table missed is read again, served fresh, and its row fixed", async () => {
    const store = await workspace();
    const client = await filled(store);
    await store.put("1-projects/beta/overview.md", "---\nstatus: done\n---\n# Beta\n");
    // The write path records the new version in the tree, not the properties.
    await touchTree(store, client, { files: ["1-projects/beta/overview.md"] });
    const gets = countingGets(store);
    const first = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: true }, OWNER);
    expect(byPath(first)["1-projects/beta/overview.md"].properties.status).toBe("done");
    expect(gets).toContain("1-projects/beta/overview.md");
    gets.length = 0;
    const second = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: true }, OWNER);
    expect(byPath(second)["1-projects/beta/overview.md"].properties.status).toBe("done");
    expect(gets).toEqual([PRIVACY_KEY]);
  });

  test("a table that has not parsed the folder yet hands the read back to the bucket", async () => {
    const store = await workspace();
    for (let index = 0; index <= STALE_READ_CAP; index += 1) store.seed(`1-projects/many/n${index}.md`, "# n\n");
    const client = sqliteClient();
    while (!(await sweepTreePass(store, client)).complete);
    const result = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: true }, OWNER);
    expect(result).toMatchObject({ available: false, fill: true });
  });

  test("a tree never swept is not asked", async () => {
    const store = await workspace();
    const result = await folderNotesFromTable(store, sqliteClient(), { folder: "1-projects", subfolders: true }, OWNER);
    expect(result.available).toBe(false);
  });

  test("a folder past one page comes back in pages, every note once", async () => {
    const store = await workspace();
    const client = await filled(store);
    const { FOLDER_PAGE_ROWS } = await import("../../mcp/src/tree/props.js");
    expect(FOLDER_PAGE_ROWS).toBeGreaterThan(10);
    const result = await folderNotesFromTable(store, client, { folder: "1-projects", subfolders: true, cursor: "1-projects/alpha/task-one.md" }, OWNER);
    expect(Object.keys(byPath(result)).sort()).toEqual(["1-projects/beta/overview.md", "1-projects/pay.md"]);
  });
});
