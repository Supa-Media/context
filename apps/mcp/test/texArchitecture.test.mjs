import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ROLES, TEX_MAP, architectureFor, withArchitecture } from "../src/agent/texArchitecture.js";
import { replyJudge } from "../src/agent/replyJudge.js";
import { backgroundedBrief } from "../src/machines/jobBackground.js";
import { mapFor } from "../../../scripts/tex-architecture.mjs";
import { TEX_CONFIG } from "../src/agent/texConfig.js";

// Dev2, 2026-11-06: "make sure the architecture in code is loaded into every agents context, and tell them what part of the graph they are".

// Dev2, 2026-11-14: Tex is told its own structure from the config, the config being what runs.
test("the map is Tex's config in words: every node, and every wire by its mode", () => {
  assert.equal(TEX_MAP, mapFor(TEX_CONFIG), "regenerate with node scripts/tex-architecture.mjs");
  for (const n of TEX_CONFIG.nodes) assert.ok(TEX_MAP.includes(`- ${n.label} (`), `node ${n.id} is not in the map`);
  assert.match(TEX_MAP, /Front door \(Haiku 5\.5\)/);
  assert.match(TEX_MAP, /may call: Tools \(when action\)/);
  assert.doesNotMatch(TEX_MAP, /classDef|:::|<br\/>|```/);
});

test("every role names a node of the config, and says where it is", () => {
  const labels = new Map(TEX_CONFIG.nodes.map((n) => [n.id, n.label]));
  for (const [role, at] of Object.entries(ROLES)) {
    assert.ok(labels.has(at.node), `${role}: node "${at.node}" is not in Tex's config`);
    assert.ok(TEX_MAP.includes(labels.get(at.node)), `${role}: node "${at.node}" is not in the map`);
    const text = architectureFor(role);
    assert.ok(text.includes(TEX_MAP), `${role}: the map is whole`);
    assert.match(text, /WHERE YOU ARE: you are /);
  }
  assert.throws(() => architectureFor("nobody"), /no role nobody/);
});

test("the map goes ahead of an agent's own prompt, the same bytes every call", () => {
  const a = withArchitecture("Answer in JSON.", "reviewer");
  assert.ok(a.startsWith("HOW TEX WORKS"));
  assert.ok(a.endsWith("Answer in JSON."), "the agent's own instructions stay last");
  assert.equal(a, withArchitecture("Answer in JSON.", "reviewer"));
});

test("the reviewer's call carries the map and its box", async () => {
  const asked = [];
  const judge = replyJudge({ setting: "haiku", question: "hi", request: async (call) => (asked.push(call), { text: '{"kind":"chat","verdict":"ok","problems":[],"feedback":""}' }) });
  await judge.check("hey", { messages: [{ role: "assistant", text: "", toolCalls: [{ name: "search_notes", args: { query: "hi" } }] }] }); // a draft after an action: one with none is not reviewed
  assert.match(asked[0].system, /^HOW TEX WORKS/);
  assert.match(asked[0].system, /WHERE YOU ARE: you are the Reply reviewer/);
});

test("a computer job's brief opens with the map and its box", () => {
  const brief = backgroundedBrief({ actorClientId: "x" }, "Do the thing.", { machineName: "mac", fromOwner: true });
  assert.match(brief, /^HOW TEX WORKS/);
  assert.match(brief, /WHERE YOU ARE: you are a Background job running on a person's computer/);
  assert.ok(brief.endsWith("Do the thing."));
});
