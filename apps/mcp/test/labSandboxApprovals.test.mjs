/**
 * A Lab test chat's held asks stay in the test chat (`labSandbox/approvalsOverlay.js`, 2026-11-27). Since `REAL_GATE`
 * a test turn's email runs the real email gate, which keeps and reads approval records under `.context/approvals/`;
 * a test turn's bucket refuses every request (its binding is keyless), so those keys are the test chat's overlay.
 *
 * Sabotage: `withTestChatApprovals` returning `store` unchanged → "a test chat's held email is kept ..." fails (the
 * bucket's refusal throws out of the gate, as in the Lab on 2026-11-27).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { emailGate } from "../src/tools/emailGate.js";
import { findPending } from "../src/tools/approvals.js";
import { withTestChatApprovals } from "../src/labSandbox/approvalsOverlay.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

/** The test chat's overlay as `harness.js` hands it: newest record per key, per object. */
function overlayGate() {
  const rows = [];
  return {
    rows,
    record() {},
    async kvGet(obj, key) {
      return rows.filter((row) => row.obj === obj && row.key === key).at(-1)?.record ?? null;
    },
    async kvPut(obj, key, record) {
      rows.push({ obj, key, record });
    },
    async kvList(obj, prefix) {
      const out = new Map();
      for (const row of rows) if (row.obj === obj && row.key.startsWith(prefix)) out.set(row.key, { key: row.key, gone: row.record.gone === true, meta: row.record.meta ?? null });
      return [...out.values()];
    },
  };
}

/** A store whose bucket refuses an approval key, as a test turn's keyless binding does. */
function keylessStore() {
  const store = createMemoryStore();
  const touched = [];
  for (const method of ["get", "head", "put", "delete", "list"]) {
    if (typeof store[method] !== "function") continue;
    const inner = store[method].bind(store);
    store[method] = async (first, ...rest) => {
      const key = typeof first === "string" ? first : first?.prefix ?? "";
      if (String(key).startsWith(".context/approvals")) {
        touched.push(`${method} ${key}`);
        throw new Error("the bucket refuses a keyless request");
      }
      return inner(first, ...rest);
    };
  }
  store.actor = { userId: "user_1" };
  store.email = { check: async () => ({ ok: true, from: "me@example.com" }) };
  return { store, touched };
}

const session = { actorUserId: "user_1", actorClientId: "context_texts", workspaceId: "ws_1", scope: "private", scopes: [], egress: { texting: true, ledger: { asked: [] } }, mailChecker: async () => ({ verdict: "unsure", reason: "" }) };
const EMAIL = { to: ["jo@example.com"], subject: "Lab check", body: "The Lab test works." };

test("a test chat's held email is kept in the test chat, read back there, and never reaches the bucket", async () => {
  const { store, touched } = keylessStore();
  const gate = overlayGate();
  const sandboxed = withTestChatApprovals(store, gate, "ws_1");
  const held = await emailGate(EMAIL, { store: sandboxed, session, target: { workspaceId: "ws_1" } });
  assert.equal(held?.held, true, "the real gate held it");
  assert.equal(JSON.parse(held.content[0].text).ok_from, "the person texting");
  assert.ok(gate.rows.some((row) => row.key.startsWith(".context/approvals/pending/")), "the record is in the overlay");
  assert.equal((await findPending(sandboxed, { name: "send_email", args: { ...EMAIL, from: "me@example.com" }, userId: "user_1" }))?.record.tool, "send_email", "and is read back from it");
  assert.deepEqual(touched, [], "the bucket was never asked");
  // Another workspace's test chat, or a store without a gate, sees none of it.
  assert.equal((await withTestChatApprovals(createMemoryStore(), gate, "ws_2").list({ prefix: ".context/approvals/pending/" })).objects.length, 0);
});

test("a store with no test chat is handed back as it is", () => {
  const store = createMemoryStore();
  const get = store.get;
  assert.equal(withTestChatApprovals(store, null, "ws_1"), store);
  assert.equal(store.get, get);
  assert.equal(withTestChatApprovals(store, { record() {} }, "ws_1").get, get, "a gate with no overlay changes nothing");
});

test("a conditional write on a kept record holds only on its own etag", async () => {
  const gate = overlayGate();
  const store = withTestChatApprovals(createMemoryStore(), gate, "ws_1");
  const key = ".context/approvals/pending/2026-11-27-x.json";
  const first = await store.put(key, JSON.stringify({ id: "x" }));
  assert.equal(await store.put(key, "{}", { onlyIf: { etagMatches: "not-it" } }), null);
  assert.ok(await store.put(key, JSON.stringify({ id: "x", texting: false }), { onlyIf: { etagMatches: first.etag } }));
  assert.equal(JSON.parse(await (await store.get(key)).text()).texting, false);
  await store.delete(key);
  assert.equal(await store.get(key), null);
});
