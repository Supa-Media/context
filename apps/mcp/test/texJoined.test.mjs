// Tex says hello when it is added to a group (Dev2, 2026-11-25: "Tex should have an intro when added to a group").
// The Worker queues one turn of the group's own with `event: "joined"` (`packages/tex/worker/groupJoined.ts`); node
// `joined` gives it the gateway's own line, and only for a group.
//
// Sabotage record (2026-11-25), each fails a test here:
//  - `joinedNode` without its group check: "only a group's run is a join";
//  - `joined` dropped from `GATEWAY_NODES`: "the node has code, and sits on the shelf until a draft wires it".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { joinedNode } from "../../../packages/tex/gateway/agent/graph/nodes/joined.js";
import { JOINED_EVENT, JOINED_QUESTION } from "../../../packages/tex/gateway/agent/joined.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { taggedLine } from "../../../packages/tex/gateway/agent/groupTurnCause.js";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";

const shelf = JSON.parse(readFileSync(new URL("../../../packages/tex/src/texNodeShelf.json", import.meta.url), "utf8"));

test("node joined gives a group's hello the gateway's own line", async () => {
  const out = await joinedNode({ event: JOINED_EVENT, group: true });
  assert.deepEqual(out, { to: "intro", question: JOINED_QUESTION });
  assert.match(JOINED_QUESTION, /^\(Not a text from anyone here\./);
  assert.match(JOINED_QUESTION, /Anything personal stays in your own 1:1 with me/);
});

test("only a group's run is a join", async () => {
  assert.equal((await joinedNode({ event: JOINED_EVENT, group: false })).to, "refuse");
  assert.equal((await joinedNode({ event: "vault_saved", group: true })).to, "refuse");
  assert.equal((await joinedNode(undefined)).to, "refuse");
});

test("the turn is told nobody texted it: it was just added", () => {
  assert.match(taggedLine({ cause: "joined" }), /^Nobody texted you: you were just added to this chat/);
});

test("the node has code, and sits on the shelf until a draft wires it", () => {
  assert.equal(typeof GATEWAY_NODES.joined, "function");
  assert.equal(TEX_CONFIG.nodes.some((node) => node.id === "joined"), false);
  assert.equal(shelf.nodes.joined?.node?.id, "joined");
  assert.deepEqual(shelf.nodes.joined.node.outSchema.find((f) => f.name === "to")?.options, "intro, refuse");
});
