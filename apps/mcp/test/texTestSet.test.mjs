/**
 * The Test Set's doors in the gateway (`src/http/texTestSet.js`; Dev2, 2026-11-15: the Test Set is people only,
 * "write and read by hand", and an agent that sees it can overfit).
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-15):
 *   the console-client check dropped        "an AI client's token never reaches the Test Set" fails
 *   editsPinnedContext check dropped        "only an @context-lc editor reaches it" fails
 *   put skips testSetProblems               "a conversation is checked against the live config" fails
 *   tex_dev summary passes runs through     "tex_dev sees counts and results, never a word" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TEX_EVAL_PREFIX, handleTexEval, handleTexTestSet, testSetProblems, testSetSummary } from "../src/http/texTestSet.js";
import { route } from "../src/http/route.js";

const WORDS = "when does my lease end";
const conversation = (over = {}) => ({
  id: "lease",
  title: "Lease and landlord",
  set: "test",
  kind: "one",
  members: ["Sam"],
  msgs: [
    { id: "m1", who: "Sam", text: WORDS, labels: { fd: { must: ["say July 31"], star: true } } },
    { id: "m2", who: "Tex", tex: true, text: "July 31." },
  ],
  ...over,
});

function fakeDoor() {
  const chats = new Map([["lease", conversation()]]);
  const calls = [];
  const counts = () => ({ chats: chats.size, stars: chats.size, byNode: { fd: chats.size }, perChat: [...chats.values()].map(() => ({ stars: 1, kind: "one", msgs: 2 })) });
  return {
    calls,
    list: async () => ({ chats: [...chats.values()].map((c) => ({ id: c.id, title: c.title, stars: 1 })), counts: counts() }),
    get: async (id) => chats.get(id) ?? null,
    put: async (c, who) => (calls.push(["put", c.id, who]), chats.set(c.id, c), { ok: true, kept: c.id, counts: counts() }),
    remove: async (id, who) => (calls.push(["remove", id, who]), chats.delete(id), { removed: id, counts: counts() }),
    allow: async (pr, who) => (calls.push(["allow", pr, who]), { ok: true, pr, left: 1 }),
    runs: async () => [],
    summary: async () => ({ counts: counts(), runs: [{ id: "r1", pr: 9, sha: "a".repeat(40), base: "b".repeat(40), gh_run: "1", at: 0, allowance: false, verdict: { pass: true, total: 1, right: 1, main: 1, byNode: { fd: { total: 1, right: 1, main: 1 } } }, title: "Lease and landlord" }] }),
  };
}
const editor = (over = {}) => ({ actorClientId: "context_console", actorUserId: "user_dev", workspaceId: "ws_me", workspaces: [{ slug: "context-lc", role: "editor", workspaceId: "ws_lc", kind: "shared" }], ...over });
const req = (method, body, query = "") => new Request(`https://mcp.example.test/tex-test-set${query}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const call = async (method, body, session = editor(), query = "", env = { TEX_EVAL: fakeDoor() }) => {
  const res = await handleTexTestSet(req(method, body, query), env, session);
  return { status: res.status, body: res.status === 405 ? null : await res.json(), env };
};

test("an AI client's token never reaches the Test Set, whoever's it is", async () => {
  const mcp = await call("GET", undefined, editor({ actorClientId: "claude_desktop" }));
  assert.equal(mcp.status, 403);
  assert.doesNotMatch(JSON.stringify(mcp.body), /lease/i);
  const write = await call("POST", { put: conversation() }, editor({ actorClientId: "tex_dev" }));
  assert.equal(write.status, 403);
  assert.equal(write.env.TEX_EVAL.calls.length, 0);
});

test("only an @context-lc editor reaches it", async () => {
  for (const workspaces of [[], [{ slug: "context-lc", role: "member", workspaceId: "ws_lc" }], [{ slug: "someone", role: "owner", workspaceId: "ws_x" }]]) {
    const r = await call("GET", undefined, editor({ workspaces }));
    assert.equal(r.status, 403, JSON.stringify(workspaces));
  }
  const owner = await call("GET", undefined, editor({ workspaces: [{ slug: "context-lc", role: "owner", workspaceId: "ws_lc" }] }));
  assert.equal(owner.status, 200);
});

test("an editor in the app lists, reads, writes, removes and allows one more run", async () => {
  const listed = await call("GET");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.chats[0].id, "lease");
  assert.equal(listed.body.counts.stars, 1);
  const one = await call("GET", undefined, editor(), "?id=lease");
  assert.equal(one.body.conversation.msgs[0].text, WORDS);
  assert.equal((await call("GET", undefined, editor(), "?id=nope")).status, 404);
  assert.equal((await call("GET", undefined, editor(), "?id=../x")).status, 400);
  const kept = await call("POST", { put: conversation({ id: "ferry" }) });
  assert.deepEqual([kept.status, kept.body.kept, kept.env.TEX_EVAL.calls[0]], [200, "ferry", ["put", "ferry", "user_dev"]]);
  const removed = await call("POST", { remove: "lease" });
  assert.equal(removed.body.removed, "lease");
  const allowed = await call("POST", { allow: 3349 });
  assert.deepEqual(allowed.body, { pr: 3349, left: 1 });
  assert.equal((await call("PUT", { put: conversation() })).status, 405);
  assert.equal((await call("POST", { nothing: 1 })).status, 400);
});

test("a conversation is checked against the live config before it is kept", async () => {
  assert.deepEqual(testSetProblems(conversation()), []);
  assert.match(testSetProblems(conversation({ set: "dev" }))[0], /set must be "test"/);
  assert.ok(testSetProblems(conversation({ msgs: [{ id: "m1", who: "Sam", text: "x", labels: { nosuchnode: { star: true } } }] })).some((p) => /no node/.test(p)));
  const bad = await call("POST", { put: conversation({ members: [] }) });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.problems.length > 0);
  assert.equal(bad.env.TEX_EVAL.calls.length, 0);
});

test("with no service bound the Lab hears it could not be reached", async () => {
  const r = await call("GET", undefined, editor(), "", {});
  assert.equal(r.status, 503);
});

test("tex_dev sees counts and results, never a word, a title or an id", async () => {
  const summary = await testSetSummary({ TEX_EVAL: fakeDoor() });
  const text = JSON.stringify(summary);
  assert.equal(summary.counts.stars, 1);
  assert.equal(summary.runs[0].pass, true);
  assert.deepEqual(summary.runs[0].byNode, { fd: { total: 1, right: 1, main: 1 } });
  assert.doesNotMatch(text, /lease|July/i);
  assert.equal(await testSetSummary({}), null);
});

test("/tex-eval/* goes to the service untouched, before any session is read", async () => {
  const seen = [];
  const env = { TEX_EVAL_HTTP: { fetch: async (r) => (seen.push([r.url, r.headers.get("authorization")]), Response.json({ chats: 0 })) } };
  const res = await route(new Request(`https://mcp.example.test${TEX_EVAL_PREFIX}counts`, { headers: { authorization: "Bearer github-oidc" } }), env, {});
  assert.equal(res.status, 200);
  assert.deepEqual(seen, [["https://mcp.example.test/tex-eval/counts", "Bearer github-oidc"]]);
  assert.equal((await handleTexEval(new Request("https://mcp.example.test/tex-eval/counts"), {})).status, 404);
});
