/**
 * A plain yes in a group chat releases a held action only while it is still
 * the most recent thing Tex asked in that chat, and only there (Dev2,
 * 2026-11-02). Before it, Cy's "Tex, yes" to Tex's dinner question, asked in
 * Ada's turn, sent Cy's two-hour-old email with no model on the turn.
 *
 * Sabotage these and a test here fails:
 *
 *  1. `textedAsk` not calling `disarmChat` on a group reply's "?" → "a
 *     question to Cy in Ada's turn" and "a check-in's question".
 *  2. `listPending` dropping its `chat` filter → "a yes in another group chat"
 *     and "a yes in their own texts".
 *  3. `rearmForText` writing every ask as their own texts' (`chat_key: null`)
 *     → "Cy's yes right after the ask" and the two above.
 *  4. `textedAsk` calling `disarmChat` only when the reply holds nothing new
 *     → "a turn that holds Ada's email and asks Cy something"; handing it no
 *     `keep` → "an ask shown again in a reply that asks something".
 *  5. `chatOfAsk` reading a record with no `chat_key` as their own texts'
 *     whoever asked it → "an ask armed before asks carried their chat".
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { createEgressWorld, request } from "./agentEgressFixtures.mjs";
import { BUILTIN_ALLOWED } from "./agentModelFixture.mjs";
import { PENDING_PREFIX, armForText, createPending, listPending } from "../src/tools/approvals.js";
import { textedAsk } from "../src/agent/textedApprovals.js";
import { createMemoryStore } from "./gmailSync/fixtures.mjs";

const TOKEN_ADA = `cat_group_chat_ada_${"0".repeat(21)}`;
const TOKEN_CY = `cat_group_chat_cy_${"0".repeat(22)}`;
const TOKEN_ADA_TEXTS = `cat_group_chat_ada_texts_${"0".repeat(15)}`;
const KEY = "d".repeat(64);
const OTHER_KEY = "c".repeat(64);
const MEMBERS = "e".repeat(64);
const EMAIL = { to: ["jo@example.com"], subject: "Thursday", body: "Hi Jo,\n\nThursday at 7 at Bo's.\n\nCy" };
const HOUR_MS = 60 * 60 * 1000;
const verdict = (value) => ({ text: JSON.stringify({ verdict: value, reason: "" }) });

let world;

before(async () => {
  world = await createEgressWorld();
  const { controlPlane } = world;
  const grant = (accessToken, userId, role, scopes, clientId = "context_texts_group", clientName = "Tex (group chats)") =>
    controlPlane.addGrant({ accessToken, workspaceId: "ws_egress_team", role, scopes, clientId, clientName, userId });
  await grant(TOKEN_ADA, "user_egress", "editor", ["context:read", "context:write"]);
  await grant(TOKEN_CY, "user_member", "member", ["context:read"]);
  // Ada's own texts with Tex, on the same workspace the chat is bound to: the one store both read.
  await grant(TOKEN_ADA_TEXTS, "user_egress", "editor", ["context:read", "context:write"], "context_texts", "Context (texts)");
  controlPlane.setBuiltinVerdict("ws_egress_team", BUILTIN_ALLOWED);
  controlPlane.flags.emailSender = "cy@gmail.example";
});
after(() => world.restore());

const live = () => [...world.team.keys()].filter((key) => key.startsWith(PENDING_PREFIX) && !String(world.team.get(key)?.body ?? "").startsWith("context.logical-delete"));
// Each test starts with nothing held.
beforeEach(() => {
  for (const key of live()) world.team.delete(key);
});

const tagged = (token, question, from, key = KEY) => request(world.env, token, "/agent", { question, group: { key, members: MEMBERS, from }, timeZone: "UTC" });
const texted = (question) => request(world.env, TOKEN_ADA_TEXTS, "/agent", { question, conversation: "texts", timeZone: "UTC" });
const sends = () => world.controlPlane.emailCalls.filter((entry) => !entry.check);

// Time passing, as the gateway sees it: every held record's times moved back (moving Date.now expires the test tokens).
function age(ms) {
  for (const key of live()) {
    const entry = world.team.get(key);
    const record = JSON.parse(entry.body);
    for (const field of ["created_at", "armed_at", "texting_until", "expires_at"]) if (Number.isFinite(record[field])) record[field] -= ms;
    world.team.set(key, { ...entry, body: JSON.stringify(record) });
  }
}

let drafts = 0;
/** Hold an email for `token`'s person in the chat `key`, and see it asked; each a new one, so none was released before. */
async function held(token, from, key = KEY) {
  drafts += 1;
  const email = { ...EMAIL, subject: `Thursday ${drafts}` };
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: email } }] }, verdict("yes"), { text: "Drafted it for Jo." }]);
  const asked = await tagged(token, "Tex email Jo that it's Thursday at 7 at Bo's", from, key);
  assert.match(asked.body?.answer ?? "", new RegExp(`@${from}, give it a 👍`));
  assert.equal(live().length, 1);
}

/** "Tex, yes" from `token`'s person; whether it sent, and whether a model saw it. */
async function yes(token, from, key = KEY) {
  const before = sends().length;
  const calls = world.model.requests.length;
  world.model.install([{ text: "Sure." }]);
  const answered = await tagged(token, "Tex, yes", from, key);
  assert.equal(answered.status, 200);
  return { sent: sends().length - before, model: world.model.requests.length > calls };
}

test("Cy's yes right after the ask sends it, with no model on the turn", async () => {
  await held(TOKEN_CY, "cy");
  assert.deepEqual(await yes(TOKEN_CY, "cy"), { sent: 1, model: false });
});

test("a late yes still sends it when Tex has asked nothing in the chat since", async () => {
  await held(TOKEN_CY, "cy");
  world.model.install([{ text: "Sunny all day." }]);
  await tagged(TOKEN_CY, "Tex what's the weather tomorrow", "cy");
  world.model.install([{ text: "Done, added to the list." }]);
  await tagged(TOKEN_ADA, "Tex add milk to the list", "ada");
  age(2 * HOUR_MS);
  assert.deepEqual(await yes(TOKEN_CY, "cy"), { sent: 1, model: false });
});

test("a question to Cy in Ada's turn means Cy's later yes answers it, not the held email", async () => {
  await held(TOKEN_CY, "cy");
  world.model.install([{ text: "Sunny all day." }]);
  await tagged(TOKEN_CY, "Tex what's the weather tomorrow", "cy");
  world.model.install([{ text: "@cy, want me to book Bo's for dinner at 8?" }]);
  await tagged(TOKEN_ADA, "Tex ask Cy if we should do dinner at Bo's at 8", "ada");
  assert.equal(live().length, 0, "Cy's email no longer waits on a bare yes");
  age(2 * HOUR_MS);
  assert.deepEqual(await yes(TOKEN_CY, "cy"), { sent: 0, model: true });
});

test("a check-in's question in the chat stops the held email listening", async () => {
  await held(TOKEN_CY, "cy");
  // A chat's check-in runs as an ordinary turn under its writer's tag (`apps/agent/src/groupRoutines.ts`).
  world.model.install([{ text: "Jo replied about Thursday. @cy, still on for 7?" }]);
  await tagged(TOKEN_ADA, "(Time for this chat's check-in: look on your own at what is new, in two places only. If nothing needs the chat, answer exactly SKIP.)", "ada");
  assert.deepEqual(await yes(TOKEN_CY, "cy"), { sent: 0, model: true });
});

test("a yes in another group chat never releases it, and the one asked here still does", async () => {
  await held(TOKEN_CY, "cy");
  assert.deepEqual(await yes(TOKEN_CY, "cy", OTHER_KEY), { sent: 0, model: true });
  assert.equal(live().length, 1, "still armed in its own chat");
  assert.deepEqual(await yes(TOKEN_CY, "cy"), { sent: 1, model: false });
});

test("a yes in their own texts never releases a group's ask, nor a group's yes their own texts' ask", async () => {
  await held(TOKEN_ADA, "ada");
  world.model.install([{ text: "Sure." }]);
  const before = sends().length;
  const own = await texted("yes");
  assert.equal(own.status, 200);
  assert.equal(sends().length, before, "their own texts' yes sends nothing asked in the chat");
  assert.deepEqual(await yes(TOKEN_ADA, "ada"), { sent: 1, model: false });

  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: { ...EMAIL, subject: "Fri" } } }] }, verdict("yes"), { text: "Drafted it for Jo." }]);
  await texted("email Jo that it's Thursday at 7 at Bo's");
  assert.equal(live().length, 1);
  assert.deepEqual(await yes(TOKEN_ADA, "ada"), { sent: 0, model: true });
  world.model.install([{ text: "Sure." }]);
  await texted("yes");
  assert.equal(sends().length, before + 2, "their own texts' yes still sends what was asked there");
});

test("a turn that holds Ada's email and asks Cy something drops Cy's ask and keeps Ada's", async () => {
  await held(TOKEN_CY, "cy");
  const cys = live();
  const email = { ...EMAIL, to: ["bo@example.com"], subject: "Ada's" };
  world.model.install([{ toolCalls: [{ name: "send", args: { action: "email", args: email } }] }, verdict("yes"), { text: "Drafted it for Bo. @cy, are you in for 8?" }]);
  const asked = await tagged(TOKEN_ADA, "Tex email Bo that we're coming at 8", "ada");
  assert.match(asked.body?.answer ?? "", /@ada, give it a 👍/);
  assert.equal(live().length, 1);
  assert.ok(!cys.includes(live()[0]), "Cy's ask is the one dropped");
  assert.deepEqual(await yes(TOKEN_ADA, "ada"), { sent: 1, model: false });
  assert.equal(sends().at(-1).email.subject, "Ada's", "and her yes sends hers");
});

test("control: 'Tex yes, do the dinner thing' is not a verdict and releases nothing", async () => {
  await held(TOKEN_CY, "cy");
  const before = sends().length;
  age(2 * HOUR_MS);
  world.model.install([{ text: "On it." }]);
  const answered = await tagged(TOKEN_CY, "Tex yes, do the dinner thing", "cy");
  assert.equal(answered.status, 200);
  assert.equal(sends().length, before, "a yes with more words goes to the model");
});

test("control: Tex's own question in Cy's turn stops Cy's ask listening", async () => {
  await held(TOKEN_CY, "cy");
  world.model.install([{ text: "Want me to book Bo's at 8?" }]);
  await tagged(TOKEN_CY, "Tex dinner?", "cy");
  assert.deepEqual(await yes(TOKEN_CY, "cy"), { sent: 0, model: true });
});

test("an ask armed before asks carried their chat: their own texts' still answered there, a group's nowhere", async () => {
  const store = createMemoryStore();
  // Armed when raised, as every ask was before `chat_key`: the record has none.
  const raise = (clientId) =>
    createPending(store, {
      name: "send_email",
      args: { to: `${clientId}@example.test` },
      actor: { workspaceId: "ws_1", userId: "user_a", clientId, client: "Tex" },
      tier: "private",
      scopes: [],
      widening: { summary: clientId, audience: "outside" },
      workspaceId: "ws_1",
      texting: true,
    });
  const own = await raise("context_texts");
  await raise("context_texts_group");
  const reached = async (chat) => (await listPending(store, { userId: "user_a", texting: true, chat })).map(({ record }) => record.id);
  assert.deepEqual(await reached(null), [own.id], "their own texts' old ask, and not the group's");
  assert.deepEqual(await reached(KEY), [], "no group's yes reaches either");
});

test("an ask shown again in a reply that asks something stays armed, in that chat", async () => {
  const store = createMemoryStore();
  // A card's ask is the one shown again while armed (`vault/pay.js`); any armed record does here.
  const record = await createPending(store, {
    name: "send_email",
    args: { to: "jo@example.test" },
    actor: { workspaceId: "ws_1", userId: "user_a", clientId: "context_texts_group", client: "Tex" },
    tier: "private",
    scopes: [],
    widening: { summary: "email Jo", audience: "outside" },
    workspaceId: "ws_1",
    texting: true,
    armed: false,
  });
  await armForText(store, { userId: "user_a", ids: [record.id], chat: KEY });
  const { ask } = await textedAsk(store, { actorUserId: "user_a" }, [record], "Still want this one?", { who: "ada", chat: KEY });
  assert.match(ask ?? "", /@ada, give it a 👍/);
  const armed = (await listPending(store, { userId: "user_a", texting: true, chat: KEY })).map(({ record: kept }) => kept.id);
  assert.deepEqual(armed, [record.id]);
});
