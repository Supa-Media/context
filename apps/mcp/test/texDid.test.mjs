// What code did for a chat goes to Tex as data, and Tex writes the text (Dev2, 2026-11-25: "Tex's code never writes
// what Tex says"; docs/decisions/texting-assistant/no-scripted-wording.md). The Worker queues one turn of the chat's
// own with `event: "did"` and the facts (`packages/tex/worker/didFacts.ts`); node `did` hands them over as JSON.
//
// Sabotage record (2026-11-25), each fails a test here:
//  - `didFactsOf` letting a nested object through: "facts are short names and short values, or nothing";
//  - `didQuestion` adding a sentence: "the Front door is handed the facts and no words";
//  - `did` dropped from `GATEWAY_NODES`: "the node has code and sits on the shelf until a draft wires it".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { didNode } from "../../../packages/tex/gateway/agent/graph/nodes/did.js";
import { DID_EVENT, didFactsOf, didQuestion } from "../../../packages/tex/gateway/agent/did.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { taggedLine } from "../../../packages/tex/gateway/agent/groupTurnCause.js";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";

const shelf = JSON.parse(readFileSync(new URL("../../../packages/tex/src/texNodeShelf.json", import.meta.url), "utf8"));
const invited = { action: "invite", status: "invited", workspace: "@studio", people: 1, role: "member" };

test("the Front door is handed the facts and no words", async () => {
  const out = await didNode({ event: DID_EVENT, did: invited });
  assert.equal(out.to, "tell");
  assert.deepEqual(JSON.parse(out.question), { from: "context", did: invited });
  assert.equal(out.question, didQuestion(invited));
});

test("facts are short names and short values, or nothing", () => {
  assert.deepEqual(didFactsOf(invited), invited);
  for (const bad of [null, "invite", [], {}, { action: "invite" }, { action: "Invite!", status: "ok" }, { ...invited, nested: { a: 1 } }, { ...invited, note: "x".repeat(201) }, { ...invited, count: Infinity }, { ...invited, "Bad Key": 1 }]) {
    assert.equal(didFactsOf(bad), null, JSON.stringify(bad));
  }
});

test("a run that isn't a did event, or carries facts it can't read, is refused", async () => {
  assert.equal((await didNode({ event: "joined", did: invited })).to, "refuse");
  assert.equal((await didNode({ event: DID_EVENT, did: { action: "invite" } })).to, "refuse");
  assert.equal((await didNode(undefined)).to, "refuse");
});

test("its cause adds no line: the facts are the turn's whole question", () => {
  assert.equal(taggedLine({ cause: "did" }), "");
});

test("the node has code and sits on the shelf until a draft wires it", () => {
  assert.equal(typeof GATEWAY_NODES.did, "function");
  assert.equal(TEX_CONFIG.nodes.some((n) => n.id === "did"), false);
  assert.equal(shelf.nodes.did?.node?.id, "did");
  assert.equal(shelf.nodes.did.node.outSchema.find((f) => f.name === "to")?.options, "tell, refuse");
});
