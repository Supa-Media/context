/**
 * Names kept in a Lab test chat are read back on its next turn (found 2026-11-27: a made-up group chat on main never
 * offered `name_guest`, and on a preview `name_guest` was stubbed as done, so no kept name was ever seen again).
 *
 *  - a made-up chat's turn carries the key its session and ledger are named by (`chatRun.js` `atRealChat`), so the
 *    turn finds the chat's ledger, is offered `name_guest` and reads the names kept there;
 *  - `name_guest` runs for real in a test chat (`policy.js` `RUN_IN_SANDBOX`): its write lands in the test chat's own
 *    ledger (`harness.js` `ledger`), and the next read finds it; any other chat's ledger is never written (`wire.js`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { LabSandboxObject } from "../../../packages/lab/gateway/labSandbox/object.js";
import { atRealChat } from "../../../packages/lab/gateway/labSandbox/chatRun.js";
import { sandboxGate } from "../../../packages/lab/gateway/labSandbox/harness.js";
import { WORLD_SOURCE } from "../../../packages/lab/gateway/labSandbox/world.js";
import { RUN_IN_SANDBOX, toolAnswer } from "../src/labSandbox/policy.js";
import { guestNameTool, readGuestNames } from "../../../packages/tex/gateway/agent/groupGuestNames.js";
import { durableSql } from "./texStoreFixture.mjs";

const WORLD_KEY = "a".repeat(64); // `lab-world:<groupId>`'s hash, which the session's texChatId names
const OBJECT_KEY = "b".repeat(64); // the chat object's own `<line>:<groupId>` hash
const MEMBERS = "d".repeat(64);

const agentRequest = (group) => new Request("https://lab-gateway.internal/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hi", group }) });

test("a made-up chat's turn carries the key its session and ledger are named by, and keeps the chat object's members", async () => {
  const about = { kind: "group", source: WORLD_SOURCE, owner: `chat:${WORLD_KEY}`, ledgerChat: WORLD_KEY, chatKey: WORLD_KEY, world: { groupId: "lab-world-0123456789abcdef" } };
  const body = await (await atRealChat(agentRequest({ key: OBJECT_KEY, members: MEMBERS, from: "ana" }), about)).json();
  assert.equal(body.group.key, WORLD_KEY, "the key the turn's ledger is found by, not the chat object's");
  assert.equal(body.group.members, MEMBERS, "a made-up chat's members are the ones the chat object worked out");
  assert.equal(body.group.from, "ana");
  assert.equal(body.question, "hi");
});

test("a copy of a real group chat still carries the real chat's key and members", async () => {
  const about = { kind: "group", owner: `chat:${WORLD_KEY}`, ledgerChat: WORLD_KEY, chatKey: WORLD_KEY, members: "e".repeat(64) };
  const body = await (await atRealChat(agentRequest({ key: OBJECT_KEY, members: MEMBERS }), about)).json();
  assert.equal(body.group.key, WORLD_KEY);
  assert.equal(body.group.members, "e".repeat(64));
});

test("a 1:1 test chat's turn is passed on as it is", async () => {
  const request = agentRequest(null);
  assert.equal(await atRealChat(request, { kind: "one" }), request);
});

test("name_guest runs for real in a test chat, never stubbed as done", async () => {
  assert.ok(RUN_IN_SANDBOX.has("name_guest"));
  const records = [];
  assert.equal(await toolAnswer("name_guest", { guest: "+12125550102", name: "Dee" }, { record: (w) => records.push(w), call: async () => ({}) }), null);
  assert.deepEqual(records, [], "nothing listed as a stubbed write");
});

test("a name kept in a test chat is in its ledger on the next turn, and another chat's ledger is never the test chat's", async () => {
  const object = new LabSandboxObject({ storage: { sql: durableSql(), setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => {} } });
  const stub = { fetch: (request) => object.fetch(request) };
  const about = { kind: "group", source: WORLD_SOURCE, world: { groupId: "lab-world-0123456789abcdef" }, owner: `chat:${WORLD_KEY}`, ledgerChat: WORLD_KEY, chatKey: WORLD_KEY };
  await stub.fetch(new Request("https://lab-sandbox.internal/init", { method: "POST", body: JSON.stringify({ about, rows: [], history: [] }) }));
  const obj = `tex#chat:${WORLD_KEY}`;
  // The chat's ledger as the turn's store hands it (`texStore/ledger.js`: by chat), over the test chat's (`wire.js`).
  const ledgerOf = (rowId) => {
    const gate = sandboxGate(stub, about, rowId);
    return {
      gate,
      ledger: {
        read: (chat, options) => gate.ledger(obj, chat).read(options),
        append: (chat, entries) => gate.ledger(obj, chat).append(entries),
      },
    };
  };
  const first = ledgerOf("t1");
  const group = { key: WORLD_KEY, people: ["sayo"], names: [{ handle: "sayo", name: "Sayo" }], guests: ["guest-1000"], numbers: [{ who: "guest-1000", phone: "+12125550102" }], size: 3 };
  const tool = guestNameTool({ group, ledger: first.ledger });
  assert.ok(tool, "offered in a group chat with a ledger");
  const kept = await tool.call({ guest: "guest-1000", name: "Dee" });
  assert.notEqual(kept.isError, true, JSON.stringify(kept));
  await first.gate.flush();
  // The next text's turn reads the chat's names from the same ledger.
  const next = ledgerOf("t2");
  const names = await readGuestNames(next.ledger, WORLD_KEY);
  assert.deepEqual(names.map(({ guest, name }) => ({ guest, name })), [{ guest: "guest-1000", name: "Dee" }]);
  // Another chat's ledger, or another object's, is not the test chat's: nothing is handed for it to write.
  assert.equal(next.gate.ledger(obj, OBJECT_KEY), null);
  assert.equal(next.gate.ledger(`tex#chat:${OBJECT_KEY}`, WORLD_KEY), null);
});
