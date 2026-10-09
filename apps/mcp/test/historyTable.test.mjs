/**
 * THE HISTORY TABLE, FILLED FROM THE BUCKET.
 *
 * A database that runs real SQL and a bucket that lists by prefix in pages.
 * What is asked is what a replay drawn from the table depends on: does a
 * backfill put in the table exactly what the bucket's own history says —
 * `activity.md`'s lines, the audit records from before it, the stored reads —
 * no more (a trivial save, a record the file already says), no less, and does
 * a pass too small to finish say so and carry on next time?
 *
 * Fake paths and names only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteClient } from "./treeFixtures.mjs";
import { MAX_ENTRIES, renderFile } from "../../../packages/shared/src/activity.cjs";
import { storageBudget } from "../src/live/readLog.js";
import { timestampSlug } from "../src/notes/paths.js";
import {
  auditBoundary,
  auditCoveredFrom,
  auditKeyTime,
  backfillHistory,
  coveredSince,
  verifyHistoryReads,
} from "../src/history/backfill.js";
import { ensureStatements, mirrorStatements, readHistoryState } from "../src/history/table.js";

const at = (iso) => Date.parse(iso);
const NOW = at("2026-10-09T12:00:00.000Z");

/** Lists by prefix, `limit` keys a page, with an opaque continuation cursor. */
function mapBucket() {
  const objects = new Map();
  let etags = 0;
  const ops = { get: 0, list: 0, put: 0 };
  return {
    objects,
    ops,
    seed(key, body) {
      objects.set(key, { body: typeof body === "string" ? body : JSON.stringify(body), etag: `e${++etags}` });
    },
    async get(key) {
      ops.get += 1;
      const object = objects.get(key);
      return object ? { etag: object.etag, text: async () => object.body } : null;
    },
    async put(key, body) {
      ops.put += 1;
      objects.set(key, { body: String(body), etag: `e${++etags}` });
      return { etag: `e${etags}` };
    },
    async list({ prefix = "", limit = 1000, cursor } = {}) {
      ops.list += 1;
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((key) => ({ key, etag: objects.get(key).etag, size: objects.get(key).body.length })),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
      };
    },
  };
}

let ids = 0;
function audit(bucket, iso, action, paths, details = {}, { prefix = ".context/audit/", client = "mcp_client_x" } = {}) {
  const key = `${prefix}${timestampSlug(new Date(iso))}-${String(++ids).padStart(8, "0")}.json`;
  bucket.seed(key, { at: iso, action, actor_scope: "private", paths, details, actor_client_id: client });
  return key;
}

function storedRead(bucket, iso, path, teamVisible = true) {
  const day = iso.slice(0, 10);
  const key = `.context/reads/${day}/${timestampSlug(new Date(iso))}-r${++ids}.json`;
  bucket.seed(key, { at: iso, tool: "read_note", path, by: "@kemi", via: "Claude", team_visible: teamVisible });
  return key;
}

function line(iso, kind, paths, extra = {}) {
  return { at: iso, kind, paths, n: paths.length, vis: "team", by: "@kemi", via: "Claude", note: "a summary", ...extra };
}

async function mirror(client, entries) {
  await client.runAll([...ensureStatements(), ...mirrorStatements(entries, { etag: "f1", now: NOW })]);
}

const rows = (client) =>
  client.db.prepare("SELECT id, at, source, kind, paths, moves, by, via, agent, team FROM history_events ORDER BY at").all();

async function fill(bucket, client, { since = 0, budget = 500 } = {}) {
  const state = await readHistoryState(client);
  return await backfillHistory(bucket, client, { since, now: NOW, budget: storageBudget(budget), state });
}

test("an audit key's time, and what a boundary and a key each claim", () => {
  const key = `.context/audit/2026-10-01T08-30-00-123Z-abc.json`;
  assert.equal(auditKeyTime(key), at("2026-10-01T08:30:00.123Z"));
  assert.equal(auditCoveredFrom(key), at("2026-10-01T08:30:00.123Z") + 1);
  assert.equal(auditCoveredFrom(auditBoundary(at("2026-10-01T00:00:00Z"))), at("2026-10-01T00:00:00Z"));
  assert.ok(auditBoundary(at("2026-10-01T08:30:00.123Z")) < key, "a boundary sorts before the keys at its instant");
});

test("a short file's merged line replaces its old self, even when it was the oldest", async () => {
  const client = sqliteClient();
  await mirror(client, [
    line("2026-10-05T10:00:00.000Z", "added", ["1-projects/b.md"]),
    line("2026-10-04T10:00:00.000Z", "revised", ["1-projects/a.md"]),
  ]);
  // a.md's line merges forward past b.md's; nothing has fallen off a file this short.
  await client.runAll(mirrorStatements([
    line("2026-10-06T10:00:00.000Z", "revised", ["1-projects/a.md", "1-projects/d.md"]),
    line("2026-10-05T10:00:00.000Z", "added", ["1-projects/b.md"]),
  ], { etag: "f2", now: NOW }));
  const got = rows(client).map((row) => [row.at, JSON.parse(row.paths)]);
  assert.deepEqual(got, [
    [at("2026-10-05T10:00:00.000Z"), ["1-projects/b.md"]],
    [at("2026-10-06T10:00:00.000Z"), ["1-projects/a.md", "1-projects/d.md"]],
  ]);
  const state = await readHistoryState(client);
  assert.equal(state.activityFrom, at("2026-10-04T10:00:00.000Z"), "the first mirror's start is kept");
  assert.equal(state.mirrorEtag, "f2");
  assert.ok(!client.db.prepare("SELECT 1 FROM history_events WHERE paths LIKE '%summary%'").get(), "no summary text");
});

test("a line that falls off the end of a full file stays in the table", async () => {
  const client = sqliteClient();
  const base = at("2026-09-01T00:00:00.000Z");
  const lineAt = (index) => line(new Date(base + index * 3_600_000).toISOString(), "added", [`1-projects/n${index}.md`]);
  // Newest first, as the file keeps them: 400 lines, then one more pushes the oldest off.
  const full = Array.from({ length: MAX_ENTRIES }, (_, index) => lineAt(MAX_ENTRIES - 1 - index));
  await mirror(client, full);
  await client.runAll(mirrorStatements([lineAt(MAX_ENTRIES), ...full.slice(0, -1)], { etag: "f2", now: NOW }));
  const paths = rows(client).map((row) => JSON.parse(row.paths)[0]);
  assert.equal(paths.length, MAX_ENTRIES + 1);
  assert.equal(paths[0], "1-projects/n0.md", "the line that fell off");
  assert.equal(paths.at(-1), `1-projects/n${MAX_ENTRIES}.md`);
});

test("a backfill writes the audit records from before the file, the way the file would have, and the reads", async () => {
  const bucket = mapBucket();
  const client = sqliteClient();
  const fileFrom = "2026-10-05T10:00:00.000Z";
  await mirror(client, [line(fileFrom, "added", ["1-projects/a.md"])]);
  audit(bucket, "2026-09-20T09:00:00.000Z", "create_note", ["1-projects/old.md"], { team_visible: true });
  audit(bucket, "2026-09-21T09:00:00.000Z", "update_note", ["1-projects/old.md"], { team_visible: true, content_bytes: 100, previous_bytes: 99 });
  audit(bucket, "2026-08-15T09:00:00.000Z", "move_note", ["2-areas/x.md", "2-areas/y.md"], {});
  audit(bucket, "2026-08-16T09:00:00.000Z", "create_note", ["2-areas/by-hand.md"], {}, { client: "context_console" });
  audit(bucket, "2026-10-06T09:00:00.000Z", "create_note", ["1-projects/new.md"], { team_visible: true });
  audit(bucket, "2026-09-25T09:00:00.000Z", "propose_note", [".context/proposals/p.md"], {});
  audit(bucket, "2026-07-01T09:00:00.000Z", "create_note", ["3-resources/legacy.md"], { team_visible: true }, { prefix: ".audit/" });
  storedRead(bucket, "2026-10-08T09:00:00.000Z", "1-projects/a.md");
  storedRead(bucket, "2026-10-09T09:00:00.000Z", "2-areas/x.md", false);

  const state = await fill(bucket, client);
  assert.ok(coveredSince(state, 0, NOW), "everything the bucket holds is in the table");
  const got = rows(client);
  const sources = got.map((row) => `${row.source}:${row.kind}:${JSON.parse(row.paths)[0]}`);
  assert.deepEqual(sources, [
    "audit:added:3-resources/legacy.md",
    "audit:moved:2-areas/x.md",
    "audit:added:2-areas/by-hand.md",
    "audit:added:1-projects/old.md",
    "activity:added:1-projects/a.md",
    "read:read:1-projects/a.md",
    "read:read:2-areas/x.md",
  ]);
  const moved = got.find((row) => row.kind === "moved");
  assert.deepEqual(JSON.parse(moved.moves), [["2-areas/x.md", "2-areas/y.md"]], "a move keeps its pair");
  assert.equal(moved.team, 0, "a record with no team flag is private, as list_changes reads it");
  assert.equal(got.find((row) => row.paths.includes("old.md")).team, 1);
  assert.equal(got.find((row) => row.paths.includes("old.md")).agent, 1, "a tool's change");
  assert.equal(got.find((row) => row.paths.includes("by-hand")).agent, 0, "the console's is a person's");
  assert.equal(got.find((row) => row.paths.includes("2-areas/x.md") && row.source === "read").team, 0);
});

test("a record the file's oldest line already says is not written twice", async () => {
  const bucket = mapBucket();
  const client = sqliteClient();
  await mirror(client, [line("2026-10-05T10:00:00.000Z", "added", ["1-projects/a.md", "1-projects/b.md"])]);
  audit(bucket, "2026-10-05T09:50:00.000Z", "create_note", ["1-projects/a.md"], { team_visible: true });
  audit(bucket, "2026-10-05T09:40:00.000Z", "create_note", ["1-projects/elsewhere.md"], { team_visible: true });
  audit(bucket, "2026-10-04T09:40:00.000Z", "create_note", ["1-projects/a.md"], { team_visible: true });
  await fill(bucket, client);
  const audits = rows(client).filter((row) => row.source === "audit").map((row) => [row.at, JSON.parse(row.paths)[0]]);
  assert.deepEqual(audits, [
    [at("2026-10-04T09:40:00.000Z"), "1-projects/a.md"],
    [at("2026-10-05T09:40:00.000Z"), "1-projects/elsewhere.md"],
  ]);
});

test("a pass too small to finish says so, the next ones carry on, and the end is the same as one big pass", async () => {
  const seed = (bucket) => {
    for (let day = 1; day <= 28; day += 1) {
      for (let hour = 0; hour < 3; hour += 1) {
        const iso = `2026-09-${String(day).padStart(2, "0")}T${String(10 + hour).padStart(2, "0")}:00:00.000Z`;
        audit(bucket, iso, "create_note", [`1-projects/n${day}-${hour}.md`], { team_visible: true });
      }
    }
    for (let day = 3; day <= 9; day += 1) storedRead(bucket, `2026-10-0${day}T08:00:00.000Z`, `1-projects/r${day}.md`);
  };
  const small = mapBucket();
  const smallClient = sqliteClient();
  seed(small);
  await mirror(smallClient, [line("2026-10-02T00:00:00.000Z", "added", ["1-projects/z.md"])]);
  let passes = 0;
  let state;
  const counts = [];
  do {
    state = await fill(small, smallClient, { budget: 15 });
    counts.push(rows(smallClient).length);
    passes += 1;
  } while (!coveredSince(state, 0, NOW) && passes < 40);
  assert.ok(passes > 2, "a small budget takes several passes");
  assert.ok(counts.every((count, index) => index === 0 || count >= counts[index - 1]), "each pass only adds");
  assert.ok(coveredSince(state, 0, NOW));

  const big = mapBucket();
  const bigClient = sqliteClient();
  seed(big);
  await mirror(bigClient, [line("2026-10-02T00:00:00.000Z", "added", ["1-projects/z.md"])]);
  await fill(big, bigClient);
  const ids = (client) => rows(client).map((row) => `${row.source}:${row.at}:${row.paths}`);
  assert.deepEqual(ids(smallClient), ids(bigClient));
  assert.equal(rows(bigClient).filter((row) => row.source === "audit").length, 84);
});

test("a pass goes only as far back as it was asked, newest first", async () => {
  const bucket = mapBucket();
  const client = sqliteClient();
  await mirror(client, [line("2026-10-05T10:00:00.000Z", "added", ["1-projects/a.md"])]);
  audit(bucket, "2026-03-01T09:00:00.000Z", "create_note", ["1-projects/spring.md"], {});
  audit(bucket, "2026-10-01T09:00:00.000Z", "create_note", ["1-projects/autumn.md"], {});
  const state = await fill(bucket, client, { since: at("2026-09-28T00:00:00.000Z") });
  assert.ok(coveredSince(state, at("2026-09-28T00:00:00.000Z"), NOW));
  assert.ok(!coveredSince(state, 0, NOW), "and claims no further");
  assert.deepEqual(rows(client).filter((row) => row.source === "audit").map((row) => JSON.parse(row.paths)[0]), ["1-projects/autumn.md"]);
});

test("the hourly re-check puts back a read whose row never landed", async () => {
  const bucket = mapBucket();
  const client = sqliteClient();
  await mirror(client, []);
  storedRead(bucket, "2026-10-09T08:00:00.000Z", "1-projects/one.md");
  let state = await fill(bucket, client);
  storedRead(bucket, "2026-10-09T09:00:00.000Z", "1-projects/lost.md");
  assert.equal(rows(client).filter((row) => row.source === "read").length, 1);
  state = await readHistoryState(client);
  assert.ok(await verifyHistoryReads(bucket, client, { now: NOW, budget: storageBudget(40), state }));
  assert.equal(rows(client).filter((row) => row.source === "read").length, 2);
  state = await readHistoryState(client);
  assert.equal(await verifyHistoryReads(bucket, client, { now: NOW + 60_000, budget: storageBudget(40), state }), false, "not again within the hour");
});

test("an empty bucket is covered at once and costs three listings to learn so", async () => {
  const bucket = mapBucket();
  const client = sqliteClient();
  await mirror(client, []);
  const state = await fill(bucket, client);
  assert.ok(coveredSince(state, 0, NOW));
  assert.equal(bucket.ops.list, 3);
  assert.equal(renderFile([], "").includes("BEGIN CONTEXT ACTIVITY"), true);
});
