/**
 * A REPLAY'S HISTORY IN ONE ASK — `GET /agent-activity?history_since=`.
 *
 * Wired end to end: the worker, a bucket that answers as S3 does, a database
 * per context that runs real SQL, and the control plane's contract. A history
 * row is a path and a hand, and a path is the customer's data, so most of
 * these are about who is *not* told:
 *
 *  1. **One context's history never reaches another's database or answer.**
 *  2. **A teammate never sees a line or a read of a note that was private when
 *     it happened, or one they cannot see now**; the owner sees everything;
 *     forwarding applies; a group note is shown exactly as the control plane's
 *     `files.listActivity` shows it (lines) and as `reads_since` does (reads).
 *  3. **The table answers what the bucket would have**, for the stretch both
 *     can answer, and a short answer says so.
 *  4. **A write is never failed, or slowed, by the table.**
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-09). Counts are failing
 * tests across this file and `historyTable.test.mjs`.
 *
 *   activityReading.cjs: `visibleEntries` ignores the event-time `vis`        1
 *   storedReads.js: `readFilterFor` ignores `team_visible`                     1
 *   serve.js: lines' live `canSee` answers yes                                 1
 *   storedReads.js: `readFilterFor` skips the live `canSee`                    1
 *   serve.js: lines given `owner: true` for every caller (drops both gates)   1
 *   serve.js: reads served without `readFilterFor`                             3
 *   serve.js: lines' paths not forwarded                                       1
 *   serve.js: `canSee` for lines given no group names                          1
 *   serve.js: any client answered, not only the console                        1
 *   table.js: `historyClientOf` pinned to one database id                      2
 *   serve.js: `complete` always true                                           3
 *   backfill.js: no dedupe against the file's oldest line                      1
 *   backfill.js: audit records kept without the file's substance rules         1
 *   readLog.js: a stored read not written to the table                         1
 *
 * Two guards are layered, so breaking one alone fails nothing: an audit
 * record from after `activityFrom` is already never listed (the walk starts
 * below that boundary), and a throw from `keepHistoryRead` lands in
 * `recordAgentRead`'s own catch, behind the response.
 *
 * Fake names, paths and credentials only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_PLANE_ORIGIN,
  DATABASE_ID,
  DESCRIPTOR,
  GATEWAY_SECRET,
  S3_ENDPOINT,
  createControlPlaneStub,
  createD1Backend,
  createS3Backend,
  createWorkerCtx,
  s3Binding,
  worker,
} from "./searchProjection/fixtures.mjs";
import { createLiveNamespace } from "./agentActivityFixtures.mjs";
import { approving } from "./egressApproval.mjs";
import { renderFile } from "../../../packages/shared/src/activity.cjs";
import { timestampSlug } from "../src/notes/paths.js";
import { HISTORY_MAX_ROWS } from "../src/history/serve.js";

const H = 3_600_000;
const DB_B = "db-1111-1111-1111-111111111111";
const tok = (name) => `cat_history_${name}_`.padEnd(40, "0");
const T = {
  ownerTool: tok("ownertool"),
  teamTool: tok("teamtool"),
  console: tok("console"),
  consoleTeam: tok("consoleteam"),
  consolePlain: tok("consoleplain"),
  consoleB: tok("consoleb"),
  toolB: tok("toolb"),
  consoleC: tok("consolec"),
  consoleD: tok("consoled"),
};

const manifest = (overrides = "  1-projects/rates.md: private\n") =>
  "---\nrole: privacy-manifest\nversion: 1\n---\n\n" +
  "<!-- BEGIN BRAIN PRIVACY RULES -->\n\n```yaml\ndefault_visibility: private\n\n" +
  "folder_defaults:\n  index.md: team\n  1-projects: team\n\n" +
  `note_overrides:\n${overrides}\`\`\`\n\n` +
  "<!-- END BRAIN PRIVACY RULES -->\n";

const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * H).toISOString();
const line = (hoursAgo, kind, paths, vis = "team", extra = {}) => ({
  at: iso(hoursAgo), kind, paths, n: paths.length, vis, by: "@kemi", via: "Claude", note: null, ...extra,
});

let seq = 0;
function seedAudit(bucket, hoursAgo, action, paths, details = {}) {
  const at = iso(hoursAgo);
  bucket.set(`.context/audit/${timestampSlug(new Date(at))}-${String(++seq).padStart(6, "0")}.json`, {
    body: JSON.stringify({ at, action, actor_scope: "private", paths, details, actor_client_id: "mcp_client_old" }),
    etag: `a${seq}`,
  });
}
function seedRead(bucket, hoursAgo, path, teamVisible) {
  const at = iso(hoursAgo);
  bucket.set(`.context/reads/${at.slice(0, 10)}/${timestampSlug(new Date(at))}-r${++seq}.json`, {
    body: JSON.stringify({ at, tool: "read_note", path, by: "@kemi", via: "Claude", team_visible: teamVisible }),
    etag: `r${seq}`,
  });
}

async function setUp({ budget } = {}) {
  const s3 = createS3Backend(S3_ENDPOINT);
  const d1 = createD1Backend();
  const controlPlane = createControlPlaneStub();
  const restores = [s3.install(), d1.install(), controlPlane.install()];
  controlPlane.addWorkspace("ws_hist_a", "hista", s3Binding("hist-a", { ...DESCRIPTOR, state: "ready" }), { kind: "shared" });
  controlPlane.addWorkspace("ws_hist_b", "histb", s3Binding("hist-b", { ...DESCRIPTOR, databaseId: DB_B, state: "ready" }));
  controlPlane.addWorkspace("ws_hist_c", "histc", s3Binding("hist-c"));
  controlPlane.addWorkspace("ws_hist_d", "histd", s3Binding("hist-d", { ...DESCRIPTOR, databaseId: "db-2222", state: "ready" }));
  const all = ["context:read", "context:write", "context:private"];
  const team = ["context:read", "context:write"];
  const grant = (accessToken, workspaceId, role, scopes, clientId, userId, extra = {}) =>
    controlPlane.addGrant({ accessToken, workspaceId, role, scopes, clientId, clientName: "Claude", userId, ...extra });
  await grant(T.ownerTool, "ws_hist_a", "owner", all, "mcp_client_owner", "user_owner");
  await grant(T.teamTool, "ws_hist_a", "editor", team, "mcp_client_team", "user_team");
  await grant(T.console, "ws_hist_a", "owner", all, "context_console", "user_owner");
  await grant(T.consoleTeam, "ws_hist_a", "editor", team, "context_console", "user_team", {
    grantedNamesByWorkspace: { ws_hist_a: ["designers"] },
  });
  await grant(T.consolePlain, "ws_hist_a", "editor", team, "context_console", "user_plain");
  await grant(T.consoleB, "ws_hist_b", "owner", all, "context_console", "user_b");
  await grant(T.toolB, "ws_hist_b", "owner", all, "mcp_client_b", "user_b");
  await grant(T.consoleC, "ws_hist_c", "owner", all, "context_console", "user_c");
  await grant(T.consoleD, "ws_hist_d", "owner", all, "context_console", "user_d");
  const env = {
    CONTROL_PLANE_URL: CONTROL_PLANE_ORIGIN,
    GATEWAY_SECRET,
    PRESENCE_ROOM: createLiveNamespace(),
    ...(budget ? { SEARCH_SUBREQUEST_BUDGET: String(budget) } : {}),
  };
  return {
    s3,
    d1,
    env,
    bucket: (name) => s3.bucketFor(name),
    restore: () => {
      for (const restore of restores.reverse()) restore();
      d1.close();
    },
  };
}

/** Each tool grant's person's own console, which approves what the gate holds (`egressApproval.mjs`). */
const consoleFor = (token) =>
  token === T.ownerTool ? T.console : token === T.teamTool ? T.consoleTeam : token === T.toolB ? T.consoleB : null;

async function call(world, token, name, args) {
  const result = await approving(async () => (await callOnce(world, token, name, args))?.result, {
    env: world.env,
    consoleToken: consoleFor(token),
    origin: "https://gateway.test",
  });
  return { jsonrpc: "2.0", id: 1, result };
}

async function callOnce(world, token, name, args) {
  const harness = createWorkerCtx();
  const response = await worker.fetch(
    new Request("https://gateway.test/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    world.env,
    harness.ctx,
  );
  const body = await response.json();
  await harness.settle();
  return body;
}

async function ask(world, token, params) {
  const harness = createWorkerCtx();
  const response = await worker.fetch(
    new Request(`https://gateway.test/agent-activity?${new URLSearchParams(params)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    world.env,
    harness.ctx,
  );
  const body = await response.json();
  await harness.settle();
  return body;
}

async function history(world, token, hoursAgo = 24 * 40, extra = {}) {
  const body = await ask(world, token, { history_since: String(Date.now() - hoursAgo * H), ...extra });
  assert.ok(body?.history, `no history in ${JSON.stringify(body).slice(0, 300)}`);
  return body.history;
}

const linePaths = (answer) => answer.entries.flatMap((entry) => entry.paths).sort();
const readPaths = (answer) => answer.reads.map((read) => read.path).sort();

/** Workspace A as it stood before the table existed, plus what AI clients then did. */
async function seedA(world) {
  const a = world.bucket("hist-a");
  a.set("privacy.md", { body: manifest(), etag: "p1" });
  a.set("index.md", { body: "# front page", etag: "i1" });
  for (const name of ["roadmap", "rates", "later", "group"]) a.set(`1-projects/${name}.md`, { body: `# ${name}`, etag: `${name}1` });
  a.set("activity.md", {
    body: renderFile([
      line(48, "revised", ["1-projects/group.md"]),
      line(50, "revised", ["1-projects/later.md"]),
      line(52, "added", ["1-projects/rates.md"], "private"),
      line(53, "added", ["1-projects/shared-later.md"], "private"),
      line(54, "added", ["1-projects/roadmap.md"]),
    ], ""),
    etag: "act1",
  });
  seedAudit(a, 24 * 30, "create_note", ["1-projects/ancient.md"], { team_visible: true });
  seedAudit(a, 24 * 31, "create_note", ["2-areas/hidden.md"], {});
  seedRead(a, 47, "index.md", true);
  seedRead(a, 46, "1-projects/rates.md", false);
  // Private when it happened, in a team folder now: the event-time flag alone holds these back.
  seedRead(a, 45, "1-projects/shared-later.md", false);
  // Now, through the gateway: two reads by a teammate's tool, a private note by the owner's.
  await call(world, T.teamTool, "read_note", { path: "1-projects/roadmap.md" });
  await call(world, T.teamTool, "read_note", { path: "1-projects/later.md" });
  await call(world, T.ownerTool, "write_note", { path: "2-areas/secret.md", content: "# secret\n\n" + "words ".repeat(40) });
  // The owner makes a team note private, and gives another to a group.
  a.set("privacy.md", { body: manifest("  1-projects/rates.md: private\n  1-projects/later.md: private\n  1-projects/group.md: @designers\n"), etag: "p2" });
}

test("the owner's replay has everything, from the file, the audit trail before it, and the reads, in one ask", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    const owner = await history(world, T.console);
    assert.equal(owner.source, "index");
    assert.equal(owner.complete, true);
    assert.deepEqual(linePaths(owner), [
      "1-projects/ancient.md", "1-projects/group.md", "1-projects/later.md", "1-projects/rates.md",
      "1-projects/roadmap.md", "1-projects/shared-later.md", "2-areas/hidden.md", "2-areas/secret.md",
    ]);
    assert.deepEqual(readPaths(owner), [
      "1-projects/later.md", "1-projects/rates.md", "1-projects/roadmap.md", "1-projects/shared-later.md", "index.md",
    ]);
    assert.ok(owner.entries.find((entry) => entry.paths[0] === "1-projects/ancient.md").agent, "an audit record is a tool's");
    assert.ok(owner.reads.every((read) => read.via === "Claude" && Number.isFinite(read.at)));
    assert.ok(owner.entries.every((entry) => !("note" in entry) && !("vis" in entry)), "no summary, no flag on the wire");
  } finally {
    world.restore();
  }
});

test("a teammate's replay hides what was private when it happened and what they cannot see now, groups as the control plane does", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    const teamView = await history(world, T.consoleTeam);
    assert.deepEqual(linePaths(teamView), ["1-projects/ancient.md", "1-projects/group.md", "1-projects/roadmap.md"]);
    assert.deepEqual(readPaths(teamView), ["1-projects/roadmap.md", "index.md"]);
    const plain = await history(world, T.consolePlain);
    assert.deepEqual(linePaths(plain), ["1-projects/ancient.md", "1-projects/roadmap.md"], "no group names, no group note");
    assert.deepEqual(readPaths(plain), ["1-projects/roadmap.md", "index.md"]);
    const tool = await ask(world, T.teamTool, { history_since: "0" });
    assert.deepEqual([tool.history.entries, tool.history.reads], [[], []], "a tool gets nothing here");
    const ownerTool = await ask(world, T.ownerTool, { history_since: "0" });
    assert.deepEqual([ownerTool.history.entries, ownerTool.history.reads], [[], []]);
  } finally {
    world.restore();
  }
});

test("a note moved since is shown where it is now, in lines and reads alike", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    await call(world, T.ownerTool, "move_note", { source: "1-projects/roadmap.md", destination: "1-projects/done/roadmap.md" });
    const teamView = await history(world, T.consoleTeam);
    assert.ok(!linePaths(teamView).includes("1-projects/roadmap.md"));
    assert.ok(teamView.entries.some((entry) => entry.kind === "added" && entry.paths.includes("1-projects/done/roadmap.md")));
    assert.ok(readPaths(teamView).includes("1-projects/done/roadmap.md") && !readPaths(teamView).includes("1-projects/roadmap.md"));
  } finally {
    world.restore();
  }
});

test("for a stretch both can answer, the table's answer is the bucket's, and its reads are reads_since's", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    for (const token of [T.console, T.consoleTeam, T.consolePlain]) {
      const since = String(Date.now() - 72 * H);
      const indexed = (await ask(world, token, { history_since: since })).history;
      world.d1.state.fail = 503;
      const fromBucket = (await ask(world, token, { history_since: since })).history;
      world.d1.state.fail = null;
      const old = await ask(world, token, { reads_since: since });
      assert.equal(indexed.source, "index");
      assert.ok(indexed.entries.length > 0 && indexed.reads.length > 0, "a comparison of something");
      assert.equal(fromBucket.source, "bucket", "a database having a bad day still answers");
      assert.deepEqual(indexed.entries, fromBucket.entries);
      assert.deepEqual(indexed.reads, fromBucket.reads);
      assert.deepEqual(indexed.reads, old.reads);
      assert.equal(fromBucket.complete, true);
    }
  } finally {
    world.restore();
  }
});

test("one context's history never reaches another's database or replay", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    const b = world.bucket("hist-b");
    b.set("privacy.md", { body: manifest(), etag: "pb" });
    b.set("1-projects/elsewhere.md", { body: "# elsewhere", etag: "eb" });
    await call(world, T.toolB, "read_note", { path: "1-projects/elsewhere.md" });
    await history(world, T.console);
    const other = await history(world, T.consoleB);
    assert.deepEqual(readPaths(other), ["1-projects/elsewhere.md"]);
    assert.deepEqual(other.entries, []);
    const inB = world.d1.rowsIn(DB_B, "SELECT paths FROM history_events").map((row) => row.paths).join("|");
    const inA = world.d1.rowsIn(DATABASE_ID, "SELECT paths FROM history_events").map((row) => row.paths).join("|");
    assert.ok(inB.includes("elsewhere") && !inB.includes("roadmap") && !inB.includes("secret"));
    assert.ok(inA.includes("roadmap") && !inA.includes("elsewhere"));
    const bRequests = world.d1.requests.filter((request) => request.databaseId === DB_B);
    assert.ok(bRequests.length > 0 && bRequests.every((request) => !String(request.params).includes("roadmap")));
  } finally {
    world.restore();
  }
});

test("a write and a read land in the table behind the response, and a database that is down fails neither", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    await history(world, T.console);
    const count = () => world.d1.rows("SELECT count(*) AS n FROM history_events WHERE source = 'read'")[0].n;
    const before = count();
    await call(world, T.teamTool, "read_note", { path: "index.md" });
    assert.equal(count(), before + 1, "a read is a row as soon as it is stored");
    const mirrored = world.d1.rows("SELECT paths FROM history_events WHERE source = 'activity'").map((row) => row.paths).join("|");
    assert.ok(mirrored.includes("secret.md"), "the owner's write reached the table");

    world.d1.state.fail = 500;
    const wrote = await call(world, T.teamTool, "write_note", { path: "1-projects/fresh.md", content: "# fresh\n\n" + "words ".repeat(40) });
    assert.ok(!wrote.result?.isError, "the write stands");
    const read = await call(world, T.teamTool, "read_note", { path: "1-projects/fresh.md" });
    assert.ok(!read.result?.isError && JSON.stringify(read).includes("fresh"), "the read stands");
    world.d1.state.fail = null;
    // An hour on, the re-check runs behind the next answer and puts the lost read back.
    world.d1.db.prepare("UPDATE index_state SET value = '0' WHERE key = 'history_verified_at'").run();
    const first = await history(world, T.console);
    assert.ok(linePaths(first).includes("1-projects/fresh.md"), "the file is read beside the table on every ask");
    const again = await history(world, T.console);
    assert.ok(readPaths(again).includes("1-projects/fresh.md"), "the lost read is back");
  } finally {
    world.restore();
  }
});

test("without a database the bucket answers as before, and says when that is short of the ask", async () => {
  const world = await setUp();
  try {
    const c = world.bucket("hist-c");
    c.set("privacy.md", { body: manifest(), etag: "pc" });
    c.set("activity.md", { body: renderFile([line(2, "added", ["1-projects/c.md"])], ""), etag: "ac" });
    seedRead(c, 1, "1-projects/c.md", true);
    const day = await history(world, T.consoleC, 24);
    assert.equal(day.source, "bucket");
    assert.equal(day.complete, true);
    assert.deepEqual([linePaths(day), readPaths(day)], [["1-projects/c.md"], ["1-projects/c.md"]]);
    const month = await history(world, T.consoleC, 24 * 30);
    assert.equal(month.complete, false, "eight days of reads is not a month");
  } finally {
    world.restore();
  }
});

test("a backfill too big for one ask says it is incomplete, and the asks after it finish the job", async () => {
  const world = await setUp({ budget: 15 });
  try {
    const d = world.bucket("hist-d");
    d.set("privacy.md", { body: manifest(), etag: "pd" });
    d.set("activity.md", { body: renderFile([line(1, "added", ["1-projects/now.md"])], ""), etag: "ad" });
    for (let index = 0; index < 60; index += 1) seedAudit(d, 24 * 3 + index, "create_note", [`1-projects/n${index}.md`], { team_visible: true });
    const answers = [];
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const answer = await history(world, T.consoleD, 24 * 20);
      answers.push(answer);
      if (answer.complete) break;
    }
    assert.equal(answers[0].complete, false, "the first ask cannot finish, and says so");
    assert.ok(answers.length > 2);
    const last = answers.at(-1);
    assert.equal(last.complete, true);
    assert.equal(last.entries.length, 61);
    const sizes = answers.map((answer) => answer.entries.length);
    assert.ok(sizes.every((size, index) => index === 0 || size >= sizes[index - 1]));
  } finally {
    world.restore();
  }
});

test("an answer bigger than the cap keeps the newest and says it is short", async () => {
  const world = await setUp();
  try {
    const d = world.bucket("hist-d");
    d.set("privacy.md", { body: manifest(), etag: "pd" });
    await history(world, T.consoleD, 1);
    const db = world.d1.dbFor("db-2222");
    const insert = db.prepare(
      "INSERT INTO history_events (id, at, source, kind, paths, moves, n, tool, by, via, agent, team) VALUES (?, ?, 'read', 'read', ?, NULL, 1, 'read_note', '@kemi', 'Claude', 1, 1)",
    );
    const base = Date.now() - 2 * H;
    db.exec("BEGIN");
    for (let index = 0; index < HISTORY_MAX_ROWS + 10; index += 1) insert.run(`r${String(index).padStart(6, "0")}`, base + index, `["1-projects/n${index}.md"]`);
    db.exec("COMMIT");
    const answer = await history(world, T.consoleD, 3);
    assert.equal(answer.truncated, true);
    assert.equal(answer.complete, false);
    assert.equal(answer.reads.length, HISTORY_MAX_ROWS);
    assert.equal(answer.reads.at(-1).path, `1-projects/n${HISTORY_MAX_ROWS + 9}.md`, "the newest is kept");
  } finally {
    world.restore();
  }
});

test("the per-day summary counts only what the caller may see, in their own day, from where history starts", async () => {
  const world = await setUp();
  try {
    await seedA(world);
    const days = async (token, offset = "0") => await ask(world, token, { history_days: "1", tz_offset_min: offset });
    const owner = await days(T.console);
    const teamView = await days(T.consoleTeam);
    const total = (answer) => answer.historyDays.reduce((sum, day) => sum + day.count, 0);
    const replay = async (token) => {
      const answer = await history(world, token, 24 * 365);
      return answer.entries.length + answer.reads.length;
    };
    assert.equal(total(owner), await replay(T.console), "a day's count is the replay's rows");
    assert.equal(total(teamView), await replay(T.consoleTeam), "and a teammate's counts are their replay's");
    assert.ok(total(teamView) < total(owner), "what a teammate may not see is not counted");
    assert.equal(owner.historyDaysComplete, true);
    const ancient = Date.now() - 24 * 31 * H;
    assert.ok(Math.abs(owner.historyStartsAt - ancient) < 60_000, "history starts at the oldest record");
    assert.ok(teamView.historyStartsAt > owner.historyStartsAt, "a teammate's starts at the oldest they may see");
    assert.ok(owner.historyDays.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.day) && day.count > 0));
    const full = await history(world, T.console, 24 * 365);
    const times = [...full.entries.map((entry) => Date.parse(entry.at)), ...full.reads.map((read) => read.at)];
    for (const offset of [840, -600]) {
      const expected = new Map();
      for (const at of times) {
        const day = new Date(at + offset * 60_000).toISOString().slice(0, 10);
        expected.set(day, (expected.get(day) ?? 0) + 1);
      }
      const got = await days(T.console, String(offset));
      assert.deepEqual(
        got.historyDays,
        [...expected.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count })),
        "each row counted on the caller's own day",
      );
    }
    const tool = await ask(world, T.teamTool, { history_days: "1" });
    assert.deepEqual(tool.historyDays, []);
  } finally {
    world.restore();
  }
});
