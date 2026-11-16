// The Lab's "Shared with developers" chats (src/labSandbox/shared.js; Dev2, 2026-11-16; decision
// docs/decisions/texting-assistant/lab-shared-chats.md). What these prove: only a chat the control plane lists now is
// read, its history is read raw and never written, a chat whose person stopped sharing is gone on the next call, a
// stranger reads nothing, and no test text, tapback, edit or retry runs on a shared chat. Fake ids and words only.
//
// Sabotage (temporary local edits, reverted, 2026-11-16):
//   shared.js `sharedChatOf` answering a chat it did not list   "a chat that isn't listed ..." fails
//   route.js readOnly guard removed                              "no test text runs ..." fails
//   shared.js `sharedLedger` passing the caller's `view`         "the history is raw only ..." fails

import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../src/labSandbox/object.js";
import { handleLabSandbox } from "../src/labSandbox/route.js";
import { eventEntry, ledgerFor, ONE_TO_ONE_CHAT } from "../src/agent/ledger.js";
import { durableSql, texStoreNamespace } from "./texStoreFixture.mjs";

const DEV = "tok_dev_example_00000000000000";
const STRANGER = "tok_stranger_example_000000000";
const GROUP = "c".repeat(64);

function world({ shared }) {
  const objects = new Map();
  const object = (name) => {
    if (!objects.has(name)) objects.set(name, new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } }));
    return objects.get(name);
  };
  const ns = { idFromName: (name) => ({ name }), get: (id) => ({ fetch: (request) => object(id.name).fetch(request) }) };
  const real = texStoreNamespace();
  const env = { LAB_SANDBOX: ns, TEX_STORE: real.namespace, CONTROL_PLANE_URL: "https://control.example.invalid", GATEWAY_SECRET: "gw-secret-example-not-real-000000" };
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const answer = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (!String(url).endsWith("/gateway/tex/lab-sandbox")) return answer({});
    asked.push(body.action);
    if (body.accessToken !== DEV) return answer({ status: "refused" });
    if (body.action === "who") return answer({ status: "ok", userId: "u_dev", chats: [], timeZone: "America/New_York" });
    if (body.action === "shared") return answer({ status: "ok", chats: shared() });
    if (body.action === "draft") return answer({ status: "not_found" });
    return answer({ status: "bad_request" });
  };
  const call = async (token, body) => {
    const response = await handleLabSandbox(new Request("https://gateway.example.invalid/tex-lab/sandbox", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), env, null);
    return { status: response.status, body: await response.json() };
  };
  return { call, env, real, asked, restore: () => (globalThis.fetch = original) };
}

const SAM = { key: "u:usam", kind: "1:1", name: "@sam", sharedBy: ["sam"], sharedAt: 1, people: 1, owner: { person: "ws_sam" }, lastAt: null };
const TEAM = { key: GROUP, kind: "group", name: "Trip", sharedBy: ["sam", "lee"], sharedAt: 2, people: 2, owner: { chat: GROUP }, lastAt: 3 };

async function seed(env) {
  const ledger = ledgerFor(env, { person: "ws_sam" });
  const at = Date.now() - 60_000;
  await ledger.append(ONE_TO_ONE_CHAT, [
    eventEntry({ id: `${at}-000001`, at, chat: ONE_TO_ONE_CHAT, kind: "text", from: { kind: "person" }, text: "book me a table" }),
    eventEntry({ id: `${at + 1}-000002`, at: at + 1, chat: ONE_TO_ONE_CHAT, kind: "text", from: { kind: "tex" }, text: "done", delivered: true, turn: "turn1" }),
    { id: "turn1r", at: at + 1, kind: "reply", turn: "turn1", clean: true },
    { id: "turn1s", at: at + 1, kind: "step", step: "node", name: "fd", ok: true },
  ]);
}

test("the list is the control plane's; a stranger reads nothing", async () => {
  const w = world({ shared: () => [SAM, TEAM, { key: "../etc", kind: "1:1", owner: { person: "x" } }] });
  try {
    assert.equal((await w.call(STRANGER, { op: "shared" })).status, 403);
    assert.equal((await w.call(STRANGER, { op: "ledger", chatId: SAM.key })).status, 403);
    const listed = await w.call(DEV, { op: "shared" });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.chats.map((c) => [c.chatId, c.kind, c.people]), [["u:usam", "1:1", 1], [GROUP, "group", 2]], "a malformed key is left out");
    assert.ok(listed.body.chats.every((c) => c.owner === undefined), "where a history file lives is never handed out");
  } finally {
    w.restore();
  }
});

test("a shared chat's history is read raw, steps included, and never written", async () => {
  const w = world({ shared: () => [SAM] });
  try {
    await seed(w.env);
    const before = w.real.calls.length;
    const read = await w.call(DEV, { op: "ledger", chatId: SAM.key, before: Number.MAX_SAFE_INTEGER });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.deepEqual(read.body.entries.map((e) => e.kind).sort(), ["reply", "step", "text", "text"]);
    const kinds = await w.call(DEV, { op: "ledger", chatId: SAM.key, kinds: ["step"], before: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(kinds.body.entries.map((e) => e.kind), ["step"]);
    assert.ok(!w.real.calls.slice(before).some((c) => /append|write|put|delete/.test(c.op)), "nothing written to the real chat");
  } finally {
    w.restore();
  }
});

test("the history is raw only: another view is never answered", async () => {
  const w = world({ shared: () => [SAM] });
  try {
    await seed(w.env);
    const sees = await w.call(DEV, { op: "ledger", chatId: SAM.key, view: "sees" });
    assert.equal(sees.status, 200);
    assert.ok(Array.isArray(sees.body.entries) && sees.body.text === undefined, "answered as raw entries");
    const pages = await w.call(DEV, { op: "ledger", chatId: SAM.key, view: "pages" });
    assert.ok(pages.body.pages === undefined);
  } finally {
    w.restore();
  }
});

test("a chat that isn't listed, or stopped being shared, does not exist", async () => {
  let list = [SAM];
  const w = world({ shared: () => list });
  try {
    await seed(w.env);
    assert.equal((await w.call(DEV, { op: "ledger", chatId: "u:uother" })).status, 404);
    assert.equal((await w.call(DEV, { op: "ledger", chatId: "me" })).status, 400, "never the caller's or anyone's own by another name");
    assert.equal((await w.call(DEV, { op: "open", source: "shared", chatId: GROUP })).status, 404);
    assert.equal((await w.call(DEV, { op: "ledger", chatId: SAM.key })).status, 200);
    list = [];
    assert.equal((await w.call(DEV, { op: "ledger", chatId: SAM.key })).status, 404, "turning sharing off takes it away at once");
    assert.equal((await w.call(DEV, { op: "open", source: "shared", chatId: SAM.key })).status, 404);
  } finally {
    w.restore();
  }
});

test("a shared chat opens with its real texts, and no test text, tapback, edit or retry runs on it", async () => {
  const w = world({ shared: () => [SAM] });
  try {
    await seed(w.env);
    const opened = await w.call(DEV, { op: "open", source: "shared", chatId: SAM.key });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.deepEqual(opened.body.rows.map((r) => [r.who, r.text, r.prod]), [["You", "book me a table", true], ["Tex", "done", true]]);
    assert.ok(!w.asked.includes("session"), "no session of the person's is ever asked for");
    const id = opened.body.sandboxId;
    const real = opened.body.rows[0].id;
    for (const body of [{ op: "send", text: "hi" }, { op: "react", msgId: real, emoji: "❤️" }, { op: "edit", msgId: real, text: "x" }, { op: "unsend", msgId: real }, { op: "retry", msgId: real }]) {
      const r = await w.call(DEV, { ...body, sandboxId: id });
      assert.equal(r.status, 403, body.op);
      assert.match(r.body.error, /read only/);
    }
    assert.equal((await w.call(DEV, { op: "get", sandboxId: id })).status, 200);
  } finally {
    w.restore();
  }
});
