/**
 * THE CHAOS SCORE COUNTED FROM THE TREE'S ROWS.
 *
 * On a served workspace the app's score is counted at read time from the
 * tree's keys (pending moves folded in), with only the per-note extras a key
 * cannot carry (long notes, contact reviews) read from the properties table.
 * It must answer exactly what the table's aggregates answer, at both
 * clearances, and score a moved folder under its new name at once.
 *
 * Sabotage-checked: answering a member from every key (not the team-visible
 * ones) fails the team case; dropping the move fold on the extras fails the
 * moved long note; dropping the `present` check lists a deleted long note.
 */

import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore, setFolderVisibility } from "../../functions/lib/fileOps";
import { chaosAfterFill, chaosScoreOf, liveChaosScoreOf, tableChaosSource } from "../../functions/lib/filesFns/chaosOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { foldedPages, nodesPagedStore, type NodePage } from "../../functions/lib/nodes/manifestStore";
import { privacyMirrorOf } from "../../functions/lib/nodes/privacyMirror";
import { compareKeys } from "../../functions/lib/nodes/sweep";
import type { PendingMove } from "../../functions/lib/nodes/moveOverlay";
import type { NodeRow } from "../../functions/lib/nodes/table";
import { sweepTreePass } from "../../../mcp/src/tree/sweep.js";
import { propFillPass } from "../../../mcp/src/tree/props.js";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { factChaosSource } from "../../functions/lib/nodes/factSources";
import { internal } from "../../_generated/api";
import { factCtx, fillAll, observeBucket, tester, workspace as convexWorkspace } from "./facts.helpers";

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
  store.seed("1-projects/calm/handbook.md", "line\n".repeat(1500));
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

async function servedOf(bucket: Bucket, moves: PendingMove[] = []) {
  const listing = await bucket.list({ limit: 10_000 });
  const rows: NodeRow[] = (listing.objects ?? [])
    .map((object: { key: string }) => ({ path: object.key }))
    .sort((a: NodeRow, b: NodeRow) => compareKeys(a.path, b.path));
  const listed: NodePage = async (after, limit) => {
    const page = rows.filter((row) => after === undefined || compareKeys(row.path, after) > 0).slice(0, Math.min(limit, 4));
    return { rows: page, cursor: page.length === Math.min(limit, 4) ? page[page.length - 1]!.path : null };
  };
  return nodesPagedStore(bucket, moves.length === 0 ? listed : foldedPages(listed, moves), await privacyMirrorOf(bucket), moves);
}

describe("chaos counted from the tree's rows", () => {
  test("answers what the table answers, for the owner and a team member", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const served = await servedOf(bucket);
    for (const clearance of [OWNER, TEAM]) {
      for (const folder of [undefined, "1-projects/crowded", "/1-projects/calm/", "2-areas/payroll"]) {
        const operation = folder === undefined ? {} : { folder };
        expect(await liveChaosScoreOf(served, tableChaosSource(client), operation, clearance)).toEqual(
          await chaosScoreOf(bucket, client, operation, clearance),
        );
      }
    }
    const member = await liveChaosScoreOf(served, tableChaosSource(client), {}, TEAM);
    expect(JSON.stringify(member)).not.toContain("payroll");
    expect(member?.longNotes.map((note) => note.path)).toEqual(["1-projects/calm/handbook.md"]);
  });

  test("a folder waiting to move is scored under its new name, its long note with it", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const served = await servedOf(bucket, [{ from: "1-projects/calm", to: "1-projects/quiet" }]);
    const answer = (await liveChaosScoreOf(served, tableChaosSource(client), {}, OWNER))!;
    expect(answer.longNotes.map((note) => note.path)).toContain("1-projects/quiet/handbook.md");
    expect(JSON.stringify(answer)).not.toContain("1-projects/calm");
    const chip = await liveChaosScoreOf(served, tableChaosSource(client), { folder: "1-projects/quiet" }, OWNER);
    expect(chip?.folder?.items).toBe(5);
  });

  test("a long note gone from the tree is not listed", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    await bucket.delete("2-areas/payroll/ledger-history.md");
    const answer = (await liveChaosScoreOf(await servedOf(bucket), tableChaosSource(client), {}, OWNER))!;
    expect(answer.longNotes.map((note) => note.path)).not.toContain("2-areas/payroll/ledger-history.md");
  });

  test("nothing until the properties fill has read the notes", async () => {
    const bucket = await workspace();
    const client = sqliteClient();
    while (!(await sweepTreePass(bucket, client)).complete);
    expect(await liveChaosScoreOf(await servedOf(bucket), tableChaosSource(client), {}, OWNER)).toBeNull();
  });

  test("the Convex facts answer what the table answers, for the owner and a team member", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const t = tester();
    const ws = await convexWorkspace(t, "chaos");
    await observeBucket(t, ws, bucket);
    await fillAll(t, ws, bucket);
    const { ctx } = factCtx(t);
    const served = await servedOf(bucket);
    for (const clearance of [OWNER, TEAM]) {
      for (const folder of [undefined, "1-projects/crowded", "/1-projects/calm/", "2-areas/payroll"]) {
        const operation = folder === undefined ? {} : { folder };
        expect(await liveChaosScoreOf(served, factChaosSource(ctx, ws, null), operation, clearance)).toEqual(
          await liveChaosScoreOf(served, tableChaosSource(client), operation, clearance),
        );
      }
    }
    const member = await liveChaosScoreOf(served, factChaosSource(ctx, ws, null), {}, TEAM);
    expect(JSON.stringify(member)).not.toContain("payroll");
  });

  test("nothing from the Convex facts until they have read every note", async () => {
    const bucket = await workspace();
    const t = tester();
    const ws = await convexWorkspace(t, "unread");
    await observeBucket(t, ws, bucket);
    const { ctx } = factCtx(t);
    expect(await liveChaosScoreOf(await servedOf(bucket), factChaosSource(ctx, ws, null), {}, OWNER)).toBeNull();
  });

  test("a week ago carries over from the search database once, then is kept in Convex", async () => {
    const bucket = await workspace();
    const client = await filled(bucket);
    const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    await client.runAll([
      {
        sql: "INSERT OR REPLACE INTO index_state (key, value) VALUES (?1, ?2)",
        params: ["chaos_daily", JSON.stringify({ [day(9)]: [61.2, 40.5], [day(40)]: [99, 99] })],
      },
    ]);
    const t = tester();
    const ws = await convexWorkspace(t, "history");
    await observeBucket(t, ws, bucket);
    await fillAll(t, ws, bucket);
    const { ctx } = factCtx(t);
    const served = await servedOf(bucket);
    // The first read finds no history yet, and carries the database's over as it records today.
    expect((await liveChaosScoreOf(served, factChaosSource(ctx, ws, client), {}, OWNER))!.weekAgo).toBeNull();
    const owner = (await liveChaosScoreOf(served, factChaosSource(ctx, ws, null), {}, OWNER))!;
    const member = (await liveChaosScoreOf(served, factChaosSource(ctx, ws, null), {}, TEAM))!;
    expect([owner.weekAgo, member.weekAgo]).toEqual([61.2, 40.5]);
    const days = await t.run(async (ctx) => (await ctx.db.query("nodeChaosDays").collect()).map((row) => row.day).sort());
    // The last 35 recorded days are kept, as the database kept them.
    expect(days).toEqual([day(40), day(9), day(0)]);
    expect(await t.query(internal.functions.nodeChaos.history, { workspaceId: ws, daysAgo: 0, now: Date.now() })).toMatchObject({
      then: { all: Math.round(owner.score! * 10) / 10 },
      recorded: 3,
    });
  });
});
