/**
 * Who here can open a workspace the chat named (Dev2, 2026-11-25, rulebook rule 2;
 * `packages/tex/gateway/agent/groupHolders.js`): the tool hands the turn the handles as data, asks on the turn's own
 * token, and exists only in a group chat. The names here are invented.
 *
 * Sabotage record (2026-11-25): `holdersTool` returning a tool with no group fails "only in a group chat"; dropping
 * the call cap fails "a turn looks up a few, never a sweep".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { HOLDERS_SEND_ACTIONS, holdersTool, WORKSPACE_HOLDERS } from "../../../packages/tex/gateway/agent/groupHolders.js";
import { ASSISTANT_SEND_ACTIONS } from "../../../packages/tex/gateway/agent/sixTools.js";

const GROUP = { key: "a".repeat(64), from: "femi" };
const parse = (result) => JSON.parse(result.content[0].text);

test("only in a group chat, and only with a way to ask", () => {
  assert.equal(holdersTool({ group: null, holders: async () => null }), null);
  assert.equal(holdersTool({ group: GROUP, holders: null }), null);
  assert.equal(holdersTool({ group: GROUP, holders: async () => null })?.tool.name, WORKSPACE_HOLDERS);
});

test("hands the turn who here is in it, as data, from the name the chat said", async () => {
  const asked = [];
  const tool = holdersTool({ group: GROUP, holders: async (workspace) => (asked.push(workspace), { slug: "crystal-care", holders: ["ade", "bola"] }) });
  const answer = parse(await tool.call({ workspace: " Crystal Care " }));
  assert.deepEqual(answer, { workspace: "@crystal-care", holders: ["@ade", "@bola"] });
  assert.deepEqual(asked, ["Crystal Care"]);
});

test("nobody here in it reads as nothing, and a failure is an error, never a guess", async () => {
  const none = holdersTool({ group: GROUP, holders: async () => ({ slug: null, holders: ["leak"] }) });
  assert.deepEqual(parse(await none.call({ workspace: "far-co" })), { workspace: null, holders: [] });
  const down = holdersTool({ group: GROUP, holders: async () => { throw new Error("down"); } });
  const result = await down.call({ workspace: "far-co" });
  assert.equal(result.isError, true);
  assert.deepEqual(parse(result), { error: "unavailable" });
  assert.equal((await none.call({})).isError, true);
});

test("a turn looks up a few, never a sweep", async () => {
  const tool = holdersTool({ group: GROUP, holders: async () => ({ slug: null, holders: [] }) });
  for (let i = 0; i < 3; i += 1) assert.notEqual((await tool.call({ workspace: `w${i}` })).isError, true);
  assert.deepEqual(parse(await tool.call({ workspace: "w4" })), { error: "too_many_lookups", limit: 3 });
});

test("shown as send who_can_open", () => {
  assert.equal(HOLDERS_SEND_ACTIONS.who_can_open.tool, WORKSPACE_HOLDERS);
  assert.equal(ASSISTANT_SEND_ACTIONS.who_can_open?.tool, WORKSPACE_HOLDERS);
});
