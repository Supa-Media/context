/**
 * Editing a held email's body before the person's yes (`src/tools/heldEdit.js`).
 *
 * The in-app Tex card shows the held copy and lets the person change its body
 * before they press Send. Only the body may change: the record keeps who the
 * email goes to, from whom, its subject and its place in the thread, and the
 * ask keeps its yes, its expiry and its actor. Asks that are not Tex's own
 * texted email (a group chat's, a forward, an attachment, a vault's) are not
 * editable at all.
 *
 * Sabotage: drop the userId check in `reviseHeldEmail` → "another person's
 * record is not found" fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { callKey, createPending, listPending } from "../src/tools/approvals.js";
import { emailCopy, readEmail } from "../src/tools/email.js";
import { TEXTED_COPY_CAP } from "../src/tools/emailGate.js";
import { reviseHeldEmail } from "../src/tools/heldEdit.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const TEX = { workspaceId: "ws_1", userId: "user_a", clientId: "context_texts", client: "Tex" };
const OTHER = { ...TEX, userId: "user_b" };
const NOW = 1_800_000_000_000;

const EMAIL = {
  from: "me@example.test",
  to: ["ada@example.test"],
  cc: ["bo@example.test"],
  subject: "Plan",
  body: "Hi Ada,\n\nold words",
};

/** A held email as the gate raises it: its args, and the copy the person reads. */
async function held(store, args, { actor = TEX, name = "send_email", texting = true, kind, now = NOW } = {}) {
  const read = readEmail(args);
  const copy = read.email ? emailCopy(read.email) : "held";
  return createPending(store, {
    name,
    args,
    actor,
    tier: "private",
    scopes: [],
    widening: { summary: "send an email", audience: "outside" },
    detail: copy,
    workspaceId: TEX.workspaceId,
    texting,
    armed: false,
    kind,
    now,
  });
}

/** The live record for `id`, as the store holds it. */
async function stored(store, id, userId = TEX.userId) {
  return (await listPending(store, { userId, now: NOW })).find(({ record }) => record.id === id)?.record ?? null;
}

/** Set one field on a stored record in place, the way a group's ask carries `chat_key`. */
async function setField(store, id, field, value) {
  const entry = (await listPending(store, { userId: TEX.userId, now: NOW })).find(({ record }) => record.id === id);
  await store.put(entry.key, JSON.stringify({ ...entry.record, [field]: value }));
}

/** Capture the structured log lines a call writes, so a test can read them without printing. */
async function withLogs(run) {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return { result: await run(), lines };
  } finally {
    console.log = log;
  }
}

test("a held email's body is rewritten, its copy and key follow, and nothing else moves", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  const before = await stored(store, ask.id);

  const { result, lines } = await withLogs(() =>
    reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "  Hi Ada,\r\n\r\nnew line  \r\n\r\n", now: NOW + 5 }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);

  const after = await stored(store, ask.id);
  assert.equal(after.args.body, "Hi Ada,\n\nnew line");
  assert.deepEqual(
    { to: after.args.to, cc: after.args.cc, from: after.args.from, subject: after.args.subject },
    { to: EMAIL.to, cc: EMAIL.cc, from: EMAIL.from, subject: EMAIL.subject },
  );
  assert.equal(after.detail, emailCopy(readEmail({ ...EMAIL, body: "Hi Ada,\n\nnew line" }).email));
  assert.ok(after.detail.includes("new line") && !after.detail.includes("old words"));
  assert.equal(after.key, callKey("send_email", after.args));
  assert.notEqual(after.key, before.key);
  assert.equal(after.edited_at, NOW + 5);
  for (const field of ["id", "texting", "texting_until", "expires_at", "created_at", "actor", "tier", "workspace_id", "tool"]) {
    assert.deepEqual(after[field], before[field], `${field} is kept`);
  }

  // The log names the outcome only: never the body, never an address.
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { event: "held_email_edit", outcome: "edited" });
});

test("a reply keeps its thread line and its in_reply_to, and only the body changes", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const reply = { ...EMAIL, in_reply_to: "email:me@example.test/18cafe" };
  const ask = await held(store, reply);
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "Hi again", now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.record.args.in_reply_to, reply.in_reply_to);
  assert.equal(result.record.args.body, "Hi again");
  assert.ok(result.record.detail.includes("(A reply inside the existing email thread.)"));
});

test("another person's held email is not found", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  const result = await reviseHeldEmail(store, ask.id, { userId: OTHER.userId, body: "mine now", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_found" });
  assert.equal((await stored(store, ask.id)).args.body, EMAIL.body);
});

test("an ask for another tool is not editable", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, { to: "ada@example.test" }, { name: "delete_note" });
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "x", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_editable" });
});

test("a forward is not editable", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, { ...EMAIL, forward: "email:me@example.test/18cafe" });
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "x", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_editable" });
});

test("an email with attachments is not editable", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, { ...EMAIL, attach: ["file_1"] });
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "x", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_editable" });
});

test("an ask made in a group chat is not editable", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  await setField(store, ask.id, "chat_key", "g1");
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "x", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_editable" });
});

test("an ask a client other than Tex made is not editable", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const desktop = { workspaceId: "ws_1", userId: "user_a", clientId: "claude_desktop", client: "Claude Desktop" };
  const ask = await held(store, EMAIL, { actor: desktop, texting: false });
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "x", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_editable" });
});

test("a vault ask is not editable", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL, { kind: "vault_use" });
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "x", now: NOW });
  assert.deepEqual(result, { ok: false, why: "not_editable" });
});

test("an empty body is refused and nothing is written", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: " \r\n \n ", now: NOW });
  assert.deepEqual(result, { ok: false, why: "empty" });
  assert.equal((await stored(store, ask.id)).args.body, EMAIL.body);
});

test("a body too long to show whole in one text is refused", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "a".repeat(TEXTED_COPY_CAP + 1), now: NOW });
  assert.deepEqual(result, { ok: false, why: "too_long" });
  assert.equal((await stored(store, ask.id)).args.body, EMAIL.body);
});

test("a body equal to the current one changes nothing and writes nothing", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  const writes = [];
  const put = store.put;
  store.put = (key, value, options) => {
    writes.push(key);
    return put(key, value, options);
  };
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "Hi Ada,\n\nold words\n", now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.record.args.body, EMAIL.body);
  assert.deepEqual(writes, []);
});

test("a write that lost a race to another write is a conflict", async () => {
  const store = createMemoryStore();
  store.actor = { ...TEX };
  const ask = await held(store, EMAIL);
  const put = store.put;
  store.put = async (key, value, options) => {
    if (options?.onlyIf) {
      // Another writer lands first, so the version read is no longer the stored one.
      const current = await store.get(key);
      await put(key, await current.text());
    }
    return put(key, value, options);
  };
  const result = await reviseHeldEmail(store, ask.id, { userId: TEX.userId, body: "new words", now: NOW });
  assert.deepEqual(result, { ok: false, why: "conflict" });
  assert.equal((await stored(store, ask.id)).args.body, EMAIL.body);
});
