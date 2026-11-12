import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ROLES, TEX_MAP, architectureFor, withArchitecture } from "../src/agent/texArchitecture.js";
import { replyJudge } from "../src/agent/replyJudge.js";
import { backgroundedBrief } from "../src/machines/jobBackground.js";
import { mapOf } from "../../../scripts/tex-architecture-module.mjs";

// Dev2, 2026-11-06: "make sure the architecture in code is loaded into every agents context, and tell them what part of the graph they are".

test("the map is the drawing's three sections, without colours", () => {
  const page = readFileSync(new URL("../../../docs/architecture/tex.md", import.meta.url), "utf8");
  assert.equal(TEX_MAP, mapOf(page), "regenerate with node scripts/tex-architecture-module.mjs");
  assert.match(TEX_MAP, /## 1\. A text on its way to the door/);
  assert.match(TEX_MAP, /## 3\. The answer maker/);
  assert.doesNotMatch(TEX_MAP, /classDef|:::|<br\/>|## The rule|## Change log/);
});

test("every role names a box that is drawn, and says where it is", () => {
  for (const [role, at] of Object.entries(ROLES)) {
    assert.ok(TEX_MAP.includes(at.box), `${role}: box "${at.box}" is not in the drawing`);
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
  assert.match(brief, /WHERE YOU ARE: you are the job on A person's computer/);
  assert.ok(brief.endsWith("Do the thing."));
});
