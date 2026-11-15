/**
 * Node "moveChat" (staff move one chat to Tex's new number, the Photon switch): the one text the old line sends a person
 * or a group, and nothing without a number; and `/texts/move`, which runs it on the gateway's graph with its input
 * checked against the config's inSchema.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { moveChatNode } from "../src/agent/graph/nodes/moveChat.js";
import { moveForTexts } from "../src/agent/textsMove.js";

const NUMBER = "+15555550142";
const PERSON = "Tex here, swapping numbers: I'm on +1 (555) 555-0142 now. Same Tex, same notes, just text me there from now on.";
const GROUP = "Hey all, swapping numbers here: same Tex, different phone number. I'm on +1 (555) 555-0142 now, so that's me from here on.";

test("a person is told to text the new number; a group is told Tex is swapping numbers", async () => {
  assert.deepEqual(await moveChatNode({ kind: "person", number: NUMBER }), { to: "person", text: PERSON });
  assert.deepEqual(await moveChatNode({ kind: "group", number: NUMBER }), { to: "group", text: GROUP });
  assert.deepEqual(await moveChatNode({ kind: "person", number: NUMBER, archiveOn: "2026-12-01" }), { to: "person", text: `${PERSON} This number stops working on December 1.` });
});

test("with no new number, or one that is not a phone, nothing is sent", async () => {
  assert.deepEqual(await moveChatNode({ kind: "person" }), { to: "skip" });
  assert.deepEqual(await moveChatNode({ kind: "group", number: null }), { to: "skip" });
  assert.deepEqual(await moveChatNode({ kind: "person", number: "5555550142" }), { to: "skip" });
});

const post = (body) => new Request("https://gateway/texts/move", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

test("/texts/move runs the node on the config's graph and answers its output", async () => {
  const response = await moveForTexts(post({ kind: "person", number: NUMBER }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { to: "person", text: PERSON });
});

test("/texts/move refuses a body the node's inSchema does not allow, and a body that is not JSON", async () => {
  for (const body of [{ kind: "person", number: NUMBER, text: "words never travel here" }, { number: NUMBER }, { kind: "sideways", number: NUMBER }]) {
    assert.equal((await moveForTexts(post(body))).status, 422, JSON.stringify(body));
  }
  assert.equal((await moveForTexts(post("{"))).status, 400);
  assert.equal((await moveForTexts(new Request("https://gateway/texts/move"))).status, 400);
});

test("/texts/move sends nothing while the node is off in the config", async () => {
  const off = { runNode: async () => ({ ran: false }) };
  assert.deepEqual(await (await moveForTexts(post({ kind: "person", number: NUMBER }), { graph: off })).json(), { to: "skip" });
});
