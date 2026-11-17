/**
 * `tex_dev` (`src/texDev/tool.js`; Dev2, 2026-11-15): developing on Tex from an MCP session. Offered only to people
 * who edit @context-lc's AI setup, never to Tex; drafts through the control plane; turns probed from the chat's
 * history file exactly as they were logged.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   `tex_dev` out of STAFF_ONLY_TOOLS                 "offered to an editor's or owner's connection, not a member's" fails
 *   `tex_dev` out of WITHHELD_TOOLS                    "never offered to Tex" fails
 *   turnWorld() (replay.js) without the `e.turn === turn` filter   "a turn shows only its own entries, in order" fails
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsForSession } from "../src/tools/advertised.js";
import { STAFF_ONLY_TOOLS, toolDefinitions } from "../src/tools/registry.js";
import { textingWriteTools, WITHHELD_TOOLS } from "../src/agent/textingWrites.js";
import { agentTools } from "../src/agent/turn.js";
import { configStamp } from "../../../packages/shared/src/texConfigStamp.cjs";
import { createTexDev, TEX_DEV_WHO, toolTexDev } from "../src/texDev/tool.js";
import { guideText } from "../src/texDev/guide.js";
import { draftProblems } from "../src/texDev/check.js";
import { turnsOf } from "../src/texDev/probe.js";
import { turnAnswer } from "../src/texDev/replay.js";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

function session(role) {
  return {
    workspaceId: "ws_mine",
    workspaces: [
      { workspaceId: "ws_mine", slug: "mine", role: "owner", kind: "personal" },
      { workspaceId: "ws_pin", slug: "context-lc", role, kind: "shared" },
    ],
    scopes: ["context:read", "context:write", "context:private"],
    grantScopes: ["context:read", "context:write", "context:private"],
    actorUserId: "user_test",
    accessToken: "tok",
  };
}

const textOf = (result) => result.content.find((c) => c.type === "text")?.text ?? "";
const jsonOf = (result) => JSON.parse(textOf(result));
const mainGraph = () => JSON.parse(JSON.stringify({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges }));

/** A control plane that answers `answers[action]` (a value or a function of args) and records each call. */
function fakePlane(answers) {
  const calls = [];
  return {
    calls,
    async texDev(token, action, args) {
      calls.push({ token, action, args });
      const a = answers[action];
      return typeof a === "function" ? a(args) : (a ?? null);
    },
  };
}

test("offered to an editor's or owner's connection, not a member's, and in the six-tool list as a seventh", async () => {
  const store = { async get() { return null; } };
  for (const role of ["owner", "editor"]) {
    const names = (await toolsForSession(session(role), store)).map((t) => t.name);
    assert.ok(names.includes("tex_dev"), role);
    assert.equal(names.length, 7, role);
  }
  const member = (await toolsForSession(session("member"), store)).map((t) => t.name);
  assert.ok(!member.includes("tex_dev"));
  assert.equal(member.length, 6);
  assert.ok(STAFF_ONLY_TOOLS.has("tex_dev"));
});

test("never offered to Tex: not in a text, a group, or an agent turn", () => {
  const all = toolDefinitions();
  assert.ok(WITHHELD_TOOLS.has("tex_dev"));
  assert.ok(!textingWriteTools(all, { texting: true }).some((t) => t.name === "tex_dev"));
  assert.ok(!textingWriteTools(all, { texting: false }).some((t) => t.name === "tex_dev"));
  assert.ok(!agentTools(all).some((t) => t.name === "tex_dev"));
});

test("a connection not given the tool is refused before anything is reached", async () => {
  const result = await toolTexDev({}, { action: "list" });
  assert.equal(result.isError, true);
  assert.equal(textOf(result), TEX_DEV_WHO);
});

test("the guide names every action, the edits and main's steps", () => {
  const text = guideText();
  for (const action of ["guide", "list", "create", "get", "edit", "changes", "snapshot", "link", "check", "promote", "tool_stats", "cases", "case", "chats", "turns", "turn", "entries"]) assert.match(text, new RegExp(`- ${action} `));
  for (const n of TEX_CONFIG.nodes) assert.ok(text.includes(`  - ${n.id} (`), n.id);
  assert.match(text, /op: "unwire"/);
});

test("create from main sends main's graph; a refusal from the control plane is the one sentence", async () => {
  const plane = fakePlane({ create: { status: "ok", id: "vabc", rev: 1, name: "Try" } });
  const call = createTexDev({ env: { APP_ORIGIN: "https://context.example" }, session: session("editor"), controlPlane: plane });
  const made = jsonOf(await call("create", { name: "Try" }));
  assert.equal(made.link, "https://context.example/lab?v=vabc");
  assert.equal(JSON.parse(plane.calls[0].args.graph).nodes.length, TEX_CONFIG.nodes.length);
  // It keeps the main it was made from, so Promote merges only its own changes (texConfigStamp.cjs).
  assert.equal(plane.calls[0].args.base, configStamp(TEX_CONFIG));
  assert.equal(plane.calls[0].token, "tok");
  const refused = await createTexDev({ env: {}, session: session("editor"), controlPlane: fakePlane({ list: { status: "refused" } }) })("list");
  assert.equal(textOf(refused), TEX_DEV_WHO);
  const down = await createTexDev({ env: {}, session: session("editor"), controlPlane: fakePlane({}) })("list");
  assert.match(textOf(down), /could not be reached/);
});

test("an edit that lost to the other side says so, with what is there now and the revision to edit against", async () => {
  const plane = fakePlane({ edit: { status: "conflict", rev: 5, keys: ["n:fd:effort"], now: { "n:fd:effort": "medium" }, others: [{ rev: 5, who: "@dev2", via: "lab", said: ["set fd effort low → medium"] }] } });
  const call = createTexDev({ env: {}, session: session("editor"), controlPlane: plane });
  const answer = jsonOf(await call("edit", { draft: "vabc", rev: 3, ops: [{ op: "set", node: "fd", field: "effort", value: "high" }] }));
  assert.match(answer.refused, /changed the same thing first/);
  assert.equal(answer.next, "edit again against rev 5");
  assert.deepEqual(answer.now, { "n:fd:effort": "medium" });
});

test("changes with wait holds until a change arrives, and never past 50 seconds", async () => {
  let t = 0;
  let asks = 0;
  const plane = fakePlane({ changes: () => ({ status: "ok", rev: 2, changes: ++asks >= 3 ? [{ rev: 3, who: "@dev2", via: "lab", said: ["moved fd"], at: 1 }] : [] }) });
  const call = createTexDev({ env: {}, session: session("editor"), controlPlane: plane, sleep: async (ms) => void (t += ms), now: () => t });
  const answer = jsonOf(await call("changes", { draft: "vabc", since: 2, wait: 30 }));
  assert.equal(answer.changes.length, 1);
  assert.equal(asks, 3);
  t = 0;
  asks = -1_000;
  const quiet = jsonOf(await call("changes", { draft: "vabc", since: 2, wait: 999 }));
  assert.equal(quiet.changes.length, 0);
  assert.ok(t <= 50_000);
});

test("check and promote use the runner's and Promote's own checks", async () => {
  assert.deepEqual(draftProblems(mainGraph()), []);
  const g = mainGraph();
  g.nodes.push({ ...g.nodes[0], id: "brandnew" });
  g.nodes = g.nodes.filter((n) => n.id !== TEX_CONFIG.nodes[1].id);
  g.edges.push({ from: "brandnew", to: "nowhere", mode: "wait", when: ["*"] });
  const problems = draftProblems(g);
  assert.ok(problems.some((p) => /brandnew" is new/.test(p)));
  assert.ok(problems.some((p) => /is gone/.test(p)));
  assert.ok(problems.some((p) => /^runner: /.test(p)));
  const plane = fakePlane({ get: { status: "ok", rev: 2, graph: JSON.stringify(g) }, promote: { status: "ok" } });
  const refused = await createTexDev({ env: {}, session: session("editor"), controlPlane: plane })("promote", { draft: "vabc" });
  assert.equal(refused.isError, true);
  assert.ok(!plane.calls.some((c) => c.action === "promote"), "a draft that would be refused is not asked for");
});

test("snapshot answers the Lab's picture as an image", async () => {
  const env = { SITE_SHOTS: { fetch: async () => new Response(JSON.stringify({ png: "iVBORw0KGgo=", width: 800, height: 600, blocked: [] })) } };
  const result = await createTexDev({ env, session: session("editor"), controlPlane: fakePlane({}) })("snapshot", {});
  assert.equal(result.content[0].type, "image");
  assert.equal(result.content[0].mimeType, "image/png");
});

/** A ledger with these entries, read the way `texStore/ledger.js` reads (seq order, since/until, kinds, before). */
function fakeLedger(entries) {
  const all = entries.map((e, i) => ({ v: 1, ...e, seq: i + 1 }));
  return {
    async read(_chat, { kinds = null, since = null, until = null, before = null } = {}) {
      let out = all.filter((e) => (kinds ? kinds.includes(e.kind) : true) && (since === null || e.at >= since) && (until === null || e.at < until));
      if (before !== null) out = out.filter((e) => e.seq < before).reverse();
      return { entries: out };
    },
  };
}

const PAGE = { status: "ok", workspaceId: "ws_mine", timeZone: "America/New_York", chats: [] };
const T0 = Date.UTC(2026, 10, 14, 15, 0, 0);
const LEDGER = fakeLedger([
  { id: "a", at: T0, kind: "text", from: { kind: "person" }, text: "book the table" },
  { id: "b", at: T0 + 10, kind: "step", step: "node", name: "door", turn: "t1", ok: true, ms: 40, input: { text: "book the table" }, output: { to: "next" } },
  { id: "c", at: T0 + 60, kind: "thinking", turn: "t1", text: "They want Friday." },
  { id: "x", at: T0 + 61, kind: "step", step: "node", name: "door", turn: "t0", ok: true, ms: 5 },
  { id: "d", at: T0 + 90, kind: "tool", turn: "t1", name: "browse", ok: false, ms: 9_000, args: { url: "https://example.com" }, reason: "timed out" },
  { id: "e", at: T0 + 9_200, kind: "text", from: { kind: "tex" }, turn: "t1", text: "I couldn't reach the site." },
  { id: "f", at: T0 + 9_300, kind: "reply", turn: "t1", ms: 9_300, model: "haiku-5-5", version: { commit: "abc1234" } },
]);

test("turns lists each reply with what it answered, what Tex said and how long it took", async () => {
  const answer = await turnsOf({}, PAGE, {}, { ledgerOf: () => LEDGER });
  assert.equal(answer.turns.length, 1);
  assert.deepEqual([answer.turns[0].turn, answer.turns[0].ms, answer.turns[0].asked, answer.turns[0].said], ["t1", 9_300, "book the table", "I couldn't reach the site."]);
});

test("a turn shows only its own entries, in order, with inputs, thinking, the failed tool and the slowest steps", async () => {
  const answer = await turnAnswer({}, PAGE, { turn: "t1" }, { ledgerOf: () => LEDGER, origin: "https://context.example" });
  assert.deepEqual(answer.order.map((e) => e.label), ["node door", "thinking", "tool browse", "text from tex", "reply"]);
  assert.deepEqual(answer.order[0].input, { text: "book the table" });
  assert.equal(answer.order[1].text, "They want Friday.");
  assert.deepEqual(answer.summary.failed, [{ n: 3, what: "tool browse", why: "timed out" }]);
  assert.equal(answer.summary.slowest[0].what, "tool browse");
  assert.deepEqual(answer.summary.version, { commit: "abc1234" });
  assert.match((await turnAnswer({}, PAGE, { turn: "nope" }, { ledgerOf: () => LEDGER, origin: "https://context.example" })).error, /no turn nope/);
});

test("a chat shared with the developers is probed read only by its key; one not listed does not exist", async () => {
  const { chatsOf, openChat } = await import("../src/texDev/probe.js");
  const owners = [];
  const ledgerOf = (_env, owner) => (owners.push(owner), LEDGER);
  const shared = [{ key: "u:usam", kind: "1:1", name: "@sam", sharedBy: ["sam"], owner: { person: "ws_sam" } }, { key: "d".repeat(64), kind: "group", name: "Trip", people: 3, sharedBy: ["sam"], owner: { chat: "d".repeat(64) } }];
  const page = { ...PAGE, shared };
  assert.deepEqual(chatsOf(page).filter((c) => c.shared).map((c) => c.chat), ["u:usam", "d".repeat(64)]);
  const answer = await turnsOf({}, page, { chat: "u:usam" }, { ledgerOf });
  assert.equal(answer.turns.length, 1);
  assert.deepEqual(owners.at(-1), { person: "ws_sam" }, "the sharer's own history file, never the caller's");
  assert.deepEqual(openChat({}, page, "d".repeat(64), ledgerOf).place, { owner: { chat: "d".repeat(64) }, name: "d".repeat(64) });
  assert.throws(() => openChat({}, PAGE, "u:usam", ledgerOf), /no such chat/i, "once it is no longer shared it is not there");
  assert.throws(() => openChat({}, { ...PAGE, shared: [{ key: "u:ubad", kind: "1:1" }] }, "u:ubad", ledgerOf), /no such chat/i, "a listed chat with no owner is not opened");
});

test("tex_dev reads the shared list from the control plane on every call", async () => {
  let shared = [{ key: "u:usam", kind: "1:1", name: "@sam", sharedBy: ["sam"], owner: { person: "ws_sam" } }];
  const plane = fakePlane({ page: PAGE, shared: () => ({ status: "ok", chats: shared }) });
  const dev = createTexDev({ env: {}, session: session("editor"), controlPlane: plane });
  assert.ok(jsonOf(await dev("chats", {})).chats.some((c) => c.chat === "u:usam" && c.shared === true));
  shared = [];
  assert.ok(!jsonOf(await dev("chats", {})).chats.some((c) => c.chat === "u:usam"), "turned off, gone on the next call");
});
