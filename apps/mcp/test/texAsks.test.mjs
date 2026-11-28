/**
 * `tex_asks` (`src/tools/texAsks.js`): Tex reaches its held asks only through this Context-side action, and what
 * releases a held step stays decided in the gateway. Adversarial: the model cannot reach it, a step Tex held but never
 * showed the person cannot be approved, and another person or workspace cannot approve or even see an ask.
 *
 * Sabotage: drop the armed-in-this-chat check in `settleByText` and "an unarmed held step" fails; drop the
 * `actorUserId` scoping and "another person" fails; register `tex_asks` with the model's dispatcher and "the model"
 * fails.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { callTexAction, callToolForSession } from "../src/tools/session.js";
import { callTool } from "../src/tools/dispatch.js";
import { toolDefinitions } from "../src/tools/registry.js";
import { createPending, listPending } from "../src/tools/approvals.js";
import { VAULT_USE } from "../src/vault/asks.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";
import { armAsks, disarmAsks, disarmTexting, listAsks, settleByText, withdrawAsks, EVERY_CHAT } from "../../../packages/tex/gateway/asks.js";

const session = (userId = "u1", extra = {}) => ({ actorUserId: userId, actorClientId: "context_texts", scope: "private", scopes: [], ...extra });

/** A held step as the email gate raises it on a texted turn: unarmed until the ask goes out whole. */
async function held(store, { userId = "u1", armed = false, kind, name = "create_workspace" } = {}) {
  return createPending(store, { name, args: { slug: `w${Math.random().toString(36).slice(2, 8)}` }, actor: { userId, clientId: "context_texts", client: "Tex" }, texting: true, armed, ...(kind ? { kind } : {}) });
}

const stillWaiting = async (store, id, userId = "u1") => (await listPending(store, { userId })).some(({ record }) => record.id === id);

test("an unarmed held step, one the person was never shown, cannot be approved: Tex cannot approve its own hold", async () => {
  const store = createMemoryStore();
  const record = await held(store);
  const settled = await settleByText(store, session(), record.id, { verdict: "approve" });
  assert.equal(settled.status, "not_found");
  assert.ok(await stillWaiting(store, record.id), "the held step still waits for the person");
});

test("the model cannot reach tex_asks: the dispatcher every model call takes does not know it", async () => {
  const store = createMemoryStore();
  const record = await held(store, { armed: true });
  const answer = await callToolForSession({ name: "tex_asks", arguments: { action: "settle", id: record.id, verdict: "approve" } }, store, session()).catch((error) => ({ thrown: error }));
  assert.ok(answer.thrown || answer.isError === true, "refused");
  assert.ok(await stillWaiting(store, record.id), "nothing was released");
  const legacy = await callToolForSession({ name: "tex_asks", arguments: { action: "disarm_texting" } }, store, session(), { legacy: true }).catch((error) => ({ thrown: error }));
  assert.ok(legacy.thrown || legacy.isError === true, "refused by its old name too");
  assert.equal((await listPending(store, { userId: "u1", texting: true, chat: null })).length, 1, "still armed");
  // Not refused for some other reason only: the model's tool list never holds it, and the dispatcher has no such tool.
  assert.equal(toolDefinitions().some((tool) => tool.name === "tex_asks"), false, "never advertised");
  const direct = await callTool("tex_asks", { action: "settle", id: record.id, verdict: "approve" }, store, "private").catch((error) => ({ thrown: error }));
  assert.ok(direct.thrown || direct.isError === true, "the dispatcher refuses it");
  assert.equal(/tex_asks/.test(readFileSync(new URL("../src/tools/dispatch.js", import.meta.url), "utf8")), false, "the dispatcher has no case for it");
  assert.ok(await stillWaiting(store, record.id));
});

test("Tex's door answers tex_asks and nothing else", async () => {
  const store = createMemoryStore();
  const other = await callTexAction({ name: "send_email", arguments: { to: ["a@example.com"] } }, store, session());
  assert.equal(other.isError, true);
  const nobody = await callTexAction({ name: "tex_asks", arguments: { action: "list" } }, store, session(null));
  assert.equal(nobody.isError, true, "a session that stands for no person is refused");
});

test("another person, or a session in another workspace, can neither see nor approve nor disarm an ask", async () => {
  const mine = createMemoryStore();
  const theirs = createMemoryStore();
  const record = await held(mine, { armed: true });
  const intruder = session("u2");
  assert.deepEqual(await listAsks(mine, intruder, { texting: true, chat: EVERY_CHAT }), []);
  assert.equal((await settleByText(mine, intruder, record.id, { verdict: "approve" })).status, "not_found");
  assert.equal(await disarmAsks(mine, intruder, [{ id: record.id, etag: null }]), 0);
  await withdrawAsks(mine, intruder, [record.id]);
  await disarmTexting(mine, intruder);
  assert.equal((await listPending(mine, { userId: "u1", texting: true, chat: null })).length, 1, "still armed for its own person");
  // The same person's session, opened on another workspace's store, does not reach this workspace's ask.
  assert.equal((await settleByText(theirs, session(), record.id, { verdict: "approve" })).status, "not_found");
  assert.ok(await stillWaiting(mine, record.id));
});

test("a yes said in one chat does not reach an ask armed in another", async () => {
  const store = createMemoryStore();
  const record = await held(store);
  const group = "a".repeat(64);
  await armAsks(store, session(), { ids: [record.id], chat: group });
  assert.equal((await settleByText(store, session(), record.id, { verdict: "approve", chat: null })).status, "not_found");
  assert.ok(await stillWaiting(store, record.id));
});

test("a vault key's first use is never armed or settled by text", async () => {
  const store = createMemoryStore();
  const record = await held(store, { kind: VAULT_USE });
  await assert.rejects(armAsks(store, session(), { ids: [record.id], chat: null }));
  assert.equal((await listPending(store, { userId: "u1", texting: true, chat: null })).length, 0, "not armed");
});

test("an armed ask the person answered no to is dropped through the action", async () => {
  const store = createMemoryStore();
  const record = await held(store);
  await armAsks(store, session(), { ids: [record.id], chat: null, shown: "Want me to make it?" });
  const listed = await listAsks(store, session(), { texting: true, chat: null });
  assert.deepEqual(listed.map((entry) => entry.id), [record.id]);
  assert.equal(listed[0].key, undefined, "Tex is never handed a storage key");
  const settled = await settleByText(store, session(), record.id, { verdict: "deny" });
  assert.equal(settled.status, "denied");
  assert.equal(await stillWaiting(store, record.id), false);
});
