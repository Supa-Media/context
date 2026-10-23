/**
 * THE CHAOS SCORE COUNTED FROM THE TREE'S ROWS.
 *
 * On a served workspace the app's score is counted at read time from the
 * tree's keys (pending moves folded in), with only the per-note extras a key
 * cannot carry (long notes, contact reviews) read from the Convex facts. It
 * must answer exactly what reading those extras straight from the bucket
 * answers, at both clearances, and score a moved folder under its new name at
 * once. Until the facts have read every note there is no score: the search
 * database's own numbers it once fell back to left in phase 7.
 *
 * Sabotage-checked: answering a member from every key (not the team-visible
 * ones) fails the team case; dropping the move fold on the extras fails the
 * moved long note; dropping the `present` check lists a deleted long note.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore } from "../../functions/lib/fileOps";
import { liveChaosScoreOf, type ChaosSource } from "../../functions/lib/filesFns/chaosOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { foldedPages, nodesPagedStore, type NodePage } from "../../functions/lib/nodes/manifestStore";
import { privacyMirrorOf } from "../../functions/lib/nodes/privacyMirror";
import { compareKeys } from "../../functions/lib/nodes/sweep";
import type { PendingMove } from "../../functions/lib/nodes/moveOverlay";
import type { NodeRow } from "../../functions/lib/nodes/table";
import { chaosExtraOf } from "../../functions/lib/nodes/facts";
import { factsOf } from "../../functions/lib/nodes/factFill";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { factChaosSource } from "../../functions/lib/nodes/factSources";
import { internal } from "../../_generated/api";
import { factCtx, fillAll, observeBucket, tester, workspace as convexWorkspace } from "./facts.helpers";
import { renderPrivacyManifest, setFolderVisibility } from "../seededRules.helpers";

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

/**
 * Every note's extras read straight from the bucket, with no history: the
 * answer the facts must give, without keeping anything.
 */
async function bucketSource(store: Bucket): Promise<ChaosSource> {
  const listing = await store.list({ limit: 10_000 });
  const extras = new Map<string, { lines: number | null; exempt: boolean; review: boolean }>();
  for (const { key } of listing.objects as { key: string }[]) {
    if (!key.endsWith(".md")) continue;
    const object = await store.get(key);
    const extra = object ? chaosExtraOf(key, factsOf(key, await object.text()).props) : null;
    if (extra !== null) extras.set(key, extra);
  }
  return { extras: async () => extras, weekAgo: async () => null };
}

/** The Convex tree mirroring `bucket`, its facts filled. */
async function withFacts(bucket: Bucket, slug: string) {
  const t = tester();
  const ws = await convexWorkspace(t, slug);
  await observeBucket(t, ws, bucket);
  await fillAll(t, ws, bucket);
  const { ctx } = factCtx(t);
  return { t, ws, source: () => factChaosSource(ctx, ws) };
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
  test("the Convex facts answer what the bucket's own notes say, for the owner and a team member", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket, "chaos");
    const oracle = await bucketSource(bucket);
    const served = await servedOf(bucket);
    for (const clearance of [OWNER, TEAM]) {
      for (const folder of [undefined, "1-projects/crowded", "/1-projects/calm/", "2-areas/payroll"]) {
        const operation = folder === undefined ? {} : { folder };
        // Today's history is not yet a week old: both say nothing a week ago.
        expect(await liveChaosScoreOf(served, source(), operation, clearance)).toEqual(
          await liveChaosScoreOf(served, oracle, operation, clearance),
        );
      }
    }
    const owner = await liveChaosScoreOf(served, source(), {}, OWNER);
    expect(owner?.longNotes.map((note) => note.path).sort()).toEqual([
      "1-projects/calm/handbook.md",
      "2-areas/payroll/ledger-history.md",
    ]);
    const member = await liveChaosScoreOf(served, source(), {}, TEAM);
    expect(JSON.stringify(member)).not.toContain("payroll");
    expect(member?.longNotes.map((note) => note.path)).toEqual(["1-projects/calm/handbook.md"]);
    // The chip answers for one folder, and nothing for one the reader has no note in.
    expect((await liveChaosScoreOf(served, source(), { folder: "1-projects/crowded" }, TEAM))?.folder?.items).toBe(WORDS.length);
    expect((await liveChaosScoreOf(served, source(), { folder: "2-areas/payroll" }, TEAM))?.folder).toBeNull();
    expect((await liveChaosScoreOf(served, source(), { folder: "2-areas/payroll" }, OWNER))?.folder?.items).toBe(WORDS.length + 1);
  });

  test("a folder waiting to move is scored under its new name, its long note with it", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket, "moving");
    const served = await servedOf(bucket, [{ from: "1-projects/calm", to: "1-projects/quiet" }]);
    const answer = (await liveChaosScoreOf(served, source(), {}, OWNER))!;
    expect(answer.longNotes.map((note) => note.path)).toContain("1-projects/quiet/handbook.md");
    expect(JSON.stringify(answer)).not.toContain("1-projects/calm");
    const chip = await liveChaosScoreOf(served, source(), { folder: "1-projects/quiet" }, OWNER);
    expect(chip?.folder?.items).toBe(5);
  });

  test("a long note gone from the tree is not listed", async () => {
    const bucket = await workspace();
    const { source } = await withFacts(bucket, "gone");
    await bucket.delete("2-areas/payroll/ledger-history.md");
    const answer = (await liveChaosScoreOf(await servedOf(bucket), source(), {}, OWNER))!;
    expect(answer.longNotes.map((note) => note.path)).not.toContain("2-areas/payroll/ledger-history.md");
  });

  test("nothing from the Convex facts until they have read every note", async () => {
    const bucket = await workspace();
    const t = tester();
    const ws = await convexWorkspace(t, "unread");
    await observeBucket(t, ws, bucket);
    const { ctx } = factCtx(t);
    expect(await liveChaosScoreOf(await servedOf(bucket), factChaosSource(ctx, ws), {}, OWNER)).toBeNull();
  });

  test("history starts in Convex: today is recorded, and a week ago is read back from the recorded days", async () => {
    const bucket = await workspace();
    const { t, ws, source } = await withFacts(bucket, "history");
    const served = await servedOf(bucket);
    // Nothing recorded yet: no week ago, and nothing carried over from anywhere.
    const first = (await liveChaosScoreOf(served, source(), {}, OWNER))!;
    expect(first.weekAgo).toBeNull();
    const recorded = await t.run(async (ctx) => await ctx.db.query("nodeChaosDays").collect());
    expect(recorded.map((row) => row.day)).toEqual([new Date().toISOString().slice(0, 10)]);
    expect(await t.query(internal.functions.nodeChaos.history, { workspaceId: ws, daysAgo: 0, now: Date.now() })).toEqual({
      then: { all: Math.round(first.score! * 10) / 10, team: recorded[0]!.team },
    });
    // A day recorded nine days ago answers "a week ago" for both audiences.
    const nineDaysAgo = new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10);
    await t.run(async (ctx) => {
      await ctx.db.insert("nodeChaosDays", { workspaceId: ws, day: nineDaysAgo, all: 61.2, team: 40.5 });
    });
    const owner = (await liveChaosScoreOf(served, source(), {}, OWNER))!;
    const member = (await liveChaosScoreOf(served, source(), {}, TEAM))!;
    expect([owner.weekAgo, member.weekAgo]).toEqual([61.2, 40.5]);
  });
});
