/**
 * A device's catch-up (`lib/filesFns/treeChanges.ts`) tells each reader only
 * what their clearance could see, and the case that needs proving is the one
 * today's `privacy.md` gets wrong: a note held back from a team folder, then
 * deleted. Deleting it forgets the exception that held it back, so judged now
 * its path reads as the folder's — `team` — and a member would be handed the
 * name of a private note. Real SQL (`node:sqlite`), the real delete.
 */

import { createRequire } from "node:module";
import { beforeEach, describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import {
  DELETE_CONFIRMATION,
  deletePath,
  type FileStore,
  loadPrivacyState,
  setFolderVisibility,
  setVisibility,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { treeAudiences } from "../functions/lib/treeAudiences";
import { treeChanges } from "../functions/lib/filesFns/treeChanges";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { readTreeState } from "../../mcp/src/tree/table.js";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";
import { touchTree } from "../../mcp/src/tree/touch.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

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

type Client = ReturnType<typeof sqliteClient>;

/** Where a device that has just walked the tree would start from: now, and today's manifest. */
async function cursorNow(store: FileStore, client: Client) {
  const tree = await readTreeState(client);
  // Past every row so far, so only what follows is asked about.
  const since = tree.now! + 1;
  while ((await readTreeState(client)).now! <= since) await new Promise((resolve) => setImmediate(resolve));
  return { since, privacy: (await loadPrivacyState(store)).etag! };
}

let store: MemoryStore & FileStore;
let client: Client;

beforeEach(async () => {
  store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/launch.md", "# Launch\n");
  store.seed("1-projects/held-back.md", "# Held back\n");
  store.seed("1-projects/private/plan.md", "# Plan\n");
  store.seed("2-areas/health/vitals.md", "# Vitals\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/held-back.md", visibility: "private", clearance: OWNER });
  client = sqliteClient();
  expect((await sweepTreePass(store, client)).complete).toBe(true);
});

describe("a catch-up", () => {
  test("hands each reader the new and changed keys they can see, with the folders they live in", async () => {
    const cursor = await cursorNow(store, client);
    store.seed("1-projects/launch.md", "# Launch, again\n");
    store.seed("1-projects/new/brief.md", "# Brief\n");
    store.seed("1-projects/private/secret.md", "# Secret\n");
    await touchTree(store, client, {
      files: ["1-projects/launch.md", "1-projects/new/brief.md", "1-projects/private/secret.md"],
    });

    const member = await treeChanges(store, client, cursor, TEAM);
    expect(member.full).toBe(false);
    expect(member.entries.map((entry) => entry.path)).toEqual(["1-projects/launch.md", "1-projects/new/brief.md"]);
    expect(member.entries[0]!.etag).toBe((await store.get("1-projects/launch.md"))!.etag);
    expect(member.folders.map((folder) => folder.path)).toContain("1-projects/new");
    expect(JSON.stringify(member)).not.toContain("secret");

    const owner = await treeChanges(store, client, cursor, OWNER);
    expect(owner.entries.map((entry) => entry.path)).toContain("1-projects/private/secret.md");
  });

  test("never names a held-back note that was deleted to a member, and tells the owner", async () => {
    const before = await loadPrivacyState(store);
    const memberCursor = await cursorNow(store, client);
    await deletePath(store, { path: "1-projects/held-back.md", confirmation: DELETE_CONFIRMATION, clearance: OWNER });
    // What the console's announce records: who could see it, by the manifest from before.
    await touchTree(store, client, {
      paths: ["1-projects/held-back.md"],
      left: [{ path: "1-projects/held-back.md", audiences: treeAudiences(["1-projects/held-back.md"], before.rules, before.overrides) }],
    });

    // The delete rewrote privacy.md, so a copy judged by the old one walks again.
    const stale = await treeChanges(store, client, memberCursor, TEAM);
    expect(stale.full).toBe(true);
    expect(JSON.stringify(stale)).not.toContain("held-back");

    // Even a reader already on the new manifest — today's rules would call the
    // path `team` — is not told.
    const current = { ...memberCursor, privacy: (await loadPrivacyState(store)).etag! };
    const member = await treeChanges(store, client, current, TEAM);
    expect(member.full).toBe(false);
    expect(JSON.stringify(member)).not.toContain("held-back");

    const owner = await treeChanges(store, client, current, OWNER);
    expect(owner.gone).toEqual(["1-projects/held-back.md"]);
  });

  test("tells a member of a team note that left, and of the folder it left empty", async () => {
    store.seed("1-projects/old/notes.md", "# Notes\n");
    await touchTree(store, client, { files: ["1-projects/old/notes.md"] });
    const before = await loadPrivacyState(store);
    const cursor = await cursorNow(store, client);
    await store.delete("1-projects/old/notes.md");
    await touchTree(store, client, {
      paths: ["1-projects/old/notes.md"],
      left: [{ path: "1-projects/old/notes.md", audiences: treeAudiences(["1-projects/old/notes.md"], before.rules, before.overrides) }],
    });
    const member = await treeChanges(store, client, cursor, TEAM);
    expect(member.gone).toEqual(["1-projects/old/notes.md"]);
    expect(member.goneFolders).toEqual(["1-projects/old"]);
    expect(member.folders.map((folder) => folder.path)).toContain("1-projects");
  });

  test("a key nobody described as it left is told to the owner alone", async () => {
    const cursor = await cursorNow(store, client);
    await store.delete("1-projects/launch.md");
    await touchTree(store, client, { paths: ["1-projects/launch.md"] });
    expect((await treeChanges(store, client, cursor, TEAM)).gone).toEqual([]);
    expect((await treeChanges(store, client, cursor, OWNER)).gone).toEqual(["1-projects/launch.md"]);
  });

  test("walks again for a privacy.md it was not judged by, or a log that does not reach back", async () => {
    const cursor = await cursorNow(store, client);
    expect((await treeChanges(store, client, { since: cursor.since }, TEAM)).full).toBe(true);
    expect((await treeChanges(store, client, { ...cursor, privacy: '"elsewhere"' }, TEAM)).full).toBe(true);
    expect((await treeChanges(store, client, { ...cursor, since: 0 }, TEAM)).full).toBe(true);
    expect((await treeChanges(store, client, cursor, TEAM)).full).toBe(false);
  });

  test("pages without losing a row, and resumes a little behind the table's clock", async () => {
    const cursor = await cursorNow(store, client);
    const keys = Array.from({ length: 9 }, (_, index) => `1-projects/batch/n${index}.md`);
    for (const key of keys) store.seed(key, "# n\n");
    await touchTree(store, client, { paths: ["1-projects/batch"] });
    const seen: string[] = [];
    let at: { since: number; after?: string; privacy: string } = cursor;
    for (let page = 0; page < 10; page += 1) {
      const answer = await treeChanges(store, client, at, TEAM, { pageRows: 4 });
      seen.push(...answer.entries.map((entry) => entry.path));
      at = { since: answer.since, after: answer.after, privacy: answer.privacy! };
      if (!answer.more) {
        expect(answer.since).toBeLessThan(cursor.since);
        break;
      }
    }
    expect(seen).toEqual(keys);
  });
});
