/**
 * THE APP'S CHAOS SCORE: KEPT AS THE CONSOLE CHANGES NOTES, AND NEVER A WAY
 * TO LEARN WHAT IS HELD BACK.
 *
 * The score is the owner's rubric (2026-10-10, `apps/mcp/src/chaos/`). Here:
 *
 *  1. Nothing is scored until the properties fill has read the notes, and
 *     then everything is, once.
 *  2. A console change moves the score through `touchTree`'s rescore.
 *  3. A team member is answered from the team numbers: a folder of private
 *     notes is neither counted nor named, and a private long note is not
 *     listed.
 *  4. The folder chip answers for one folder, and nothing for a folder the
 *     reader has no note in.
 *
 * Sabotage-checked: answering a member from the owner's numbers fails 3;
 * dropping the rescore after `touchTree` fails 2.
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, setFolderVisibility } from "../functions/lib/fileOps";
import { chaosAfterFill, chaosScoreOf, rescoreTouched } from "../functions/lib/filesFns/chaosOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { sweepTreePass } from "../../mcp/src/tree/sweep.js";
import { propFillPass } from "../../mcp/src/tree/props.js";
import { touchTree } from "../../mcp/src/tree/touch.js";

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
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");
const WORDS = "plan budget people risks notes ideas launch review hiring roadmap legal design press".split(" ");

async function workspace(): Promise<Bucket> {
  const store = memoryStore() as Bucket;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (const word of WORDS) store.seed(`1-projects/crowded/${word}.md`, `# ${word}\n`);
  for (const word of WORDS.slice(0, 4)) store.seed(`1-projects/calm/${word}.md`, `# ${word}\n`);
  for (const word of WORDS) store.seed(`2-areas/payroll/${word}.md`, `# ${word}\n`);
  store.seed("2-areas/payroll/ledger-history.md", "line\n".repeat(1800));
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "2-areas/payroll", visibility: "private", clearance: OWNER });
  return store;
}

async function filled(store: Bucket) {
  const client = sqliteClient();
  while (!(await sweepTreePass(store, client)).complete);
  for (let pass = 0; pass < 20; pass += 1) {
    const props = await propFillPass(store, client);
    await chaosAfterFill(store, client, props);
    if (props.ready) return client;
  }
  throw new Error("the properties table never filled");
}

describe("chaos score for the app", () => {
  test("nothing is scored before the properties fill, and everything after it", async () => {
    const store = await workspace();
    const client = sqliteClient();
    while (!(await sweepTreePass(store, client)).complete);
    expect((await chaosScoreOf(store, client, {}, OWNER)).available).toBe(false);
    const scored = await filled(store);
    const answer = await chaosScoreOf(store, scored, {}, OWNER);
    expect(answer.available).toBe(true);
    expect(answer.score).toBeGreaterThan(0);
    expect(answer.folders.map((entry) => entry.folder)).toContain("1-projects/crowded");
  });

  test("a console change moves the score", async () => {
    const store = await workspace();
    const client = await filled(store);
    const before = (await chaosScoreOf(store, client, { folder: "1-projects/crowded" }, OWNER)).folder!;
    store.seed("1-projects/crowded/one-more.md", "# one more\n");
    await touchTree(store, client, { paths: ["1-projects/crowded/one-more.md"], files: [] });
    await rescoreTouched(store, client, { paths: ["1-projects/crowded/one-more.md"], files: [] });
    const after = (await chaosScoreOf(store, client, { folder: "1-projects/crowded" }, OWNER)).folder!;
    expect(after.items).toBe(before.items + 1);
    expect(after.chaos).toBeGreaterThan(before.chaos);
  });

  test("a team member never counts, sees or is named a private folder or note", async () => {
    const store = await workspace();
    const client = await filled(store);
    const owner = await chaosScoreOf(store, client, {}, OWNER);
    const member = await chaosScoreOf(store, client, {}, TEAM);
    expect(owner.folders.map((entry) => entry.folder)).toContain("2-areas/payroll");
    expect(owner.longNotes.map((note) => note.path)).toEqual(["2-areas/payroll/ledger-history.md"]);
    expect(member.score).not.toBe(owner.score);
    expect(JSON.stringify(member)).not.toContain("payroll");
    expect(member.longNotes).toEqual([]);
    const chip = await chaosScoreOf(store, client, { folder: "2-areas/payroll" }, TEAM);
    expect(chip.folder).toBeNull();
  });

  test("the folder chip answers for one folder", async () => {
    const store = await workspace();
    const client = await filled(store);
    const calm = await chaosScoreOf(store, client, { folder: "/1-projects/calm/" }, TEAM);
    expect(calm.folder).toEqual({ folder: "1-projects/calm", items: 4, chaos: 0 });
  });
});
