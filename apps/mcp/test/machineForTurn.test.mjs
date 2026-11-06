/**
 * A texted turn knows their computers (`machines/forTurn.js`, Dev,
 * 2026-11-04): the splitting bench (gh-149) gave every person a paired
 * computer, and no code answer of twelve ran there.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named check observed failing, reverted.
 *
 *  1. `computersLine` naming a computer with neither Claude Code nor Codex.
 *     → "a computer with no coding tool, or none at all, adds nothing to the turn" fails.
 *  2. `delegationBeside` keeping claude-code in the enum.
 *     → "with a computer paired, delegate offers no code agent, and a call naming one is sent to the computer" fails.
 *  3. `delegationBeside` passing a claude-code call through to `delegate`.
 *     → same check fails ("nothing is delegated").
 *  4. `runTheModel` not adding the line.
 *     → "a texted turn with a paired computer is told it by name" fails (`agentBackgroundRoute.test.mjs`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { COMPUTER_AGENTS, codeComputers, computersLine, delegationBeside } from "../src/machines/forTurn.js";
import { delegateSession } from "../src/agent/delegate.js";

const STUDIO = { workspaceId: "ws1", id: "mch_1", name: "Studio Mac", online: true, tools: ["claude", "codex"], folders: ["~/code"], ownerId: "u1", slots: 3 };

test("a computer with no coding tool, or none at all, adds nothing to the turn", () => {
  assert.equal(computersLine([]), "");
  assert.equal(computersLine(null), "");
  assert.equal(computersLine([{ ...STUDIO, tools: [] }]), "");
  assert.deepEqual(codeComputers([{ ...STUDIO, tools: ["claude"] }, { ...STUDIO, name: "Pi", tools: [] }]).map((each) => each.name), ["Studio Mac"]);
});

test("a texted turn with a paired computer is told it by name, what goes there, and never to ask which", () => {
  const line = computersLine([STUDIO]);
  assert.match(line, /They have a computer paired with Tex: "Studio Mac" \(online; Claude Code, Codex; 3 slots\)/);
  assert.match(line, /on_computer \{ name: "Studio Mac" \}/);
  assert.match(line, /Never Tex's cloud, never delegate/);
  assert.match(line, /never ask which repo or which computer/);
  assert.doesNotMatch(line, /plan_big_ask/, "the planner is named only when the turn has it");
  assert.match(computersLine([STUDIO], { planning: true }), /split there with plan_big_ask/);
  assert.match(computersLine([{ ...STUDIO, online: false, name: 'Old "box"' }]), /"Old 'box'" \(offline;/);
});

test("with a computer paired, delegate offers no code agent, and a call naming one is sent to the computer", async () => {
  const delegated = [];
  const plain = { tools: [{ name: "delegate", description: "Hand work off.", inputSchema: { type: "object", properties: { agent: { type: "string", enum: ["claude-code", "codex", "claude", "chatgpt"] } } } }], has: (name) => name === "delegate", call: async (args) => (delegated.push(args), { content: [{ type: "text", text: "handed" }] }) };
  assert.equal(delegationBeside(plain, []), plain, "no computer: unchanged");
  assert.equal(delegationBeside(null, [STUDIO]), null);
  const beside = delegationBeside(plain, [STUDIO]);
  assert.deepEqual(beside.tools[0].inputSchema.properties.agent.enum, ["claude", "chatgpt"]);
  assert.match(beside.tools[0].description, /goes to "Studio Mac" as a background job/);
  for (const agent of COMPUTER_AGENTS) {
    const answer = await beside.call({ agent, title: "Fix it", brief: "b" });
    assert.equal(answer.isError, true);
    assert.match(answer.content[0].text, /on_computer \{ name: "Studio Mac" \}/);
  }
  assert.equal(delegated.length, 0, "nothing is delegated");
  await beside.call({ agent: "claude", title: "Write it up", brief: "b" });
  assert.equal(delegated.length, 1, "other agents still go");
  assert.equal(beside.has("delegate"), true);
});

test("the real delegate tool keeps its shape when its code agents are taken out", () => {
  const real = delegateSession(async () => ({ content: [] }), { handle: "@maya", home: "@maya" });
  const beside = delegationBeside(real, [STUDIO]);
  const agents = beside.tools[0].inputSchema.properties.agent.enum;
  assert.ok(agents.length > 0 && agents.every((agent) => !COMPUTER_AGENTS.has(agent)));
  assert.deepEqual(beside.tools[0].inputSchema.required, real.tools[0].inputSchema.required);
  assert.ok(real.tools[0].inputSchema.properties.agent.enum.includes("claude-code"), "the original is left alone");
});

test("the turn reads their computers ahead and tells the model, wired in the entry point", () => {
  const history = readFileSync(new URL("../src/agent/texEntryPoint/readTheHistory.js", import.meta.url), "utf8");
  const model = readFileSync(new URL("../src/agent/texEntryPoint/runTheModel.js", import.meta.url), "utf8");
  assert.match(history, /tex\.ahead\("computers", \(\) => machinesFor\(/);
  assert.match(model, /computersLine\(computers, \{ planning \}\)/);
  assert.match(model, /delegationBeside\(delegated, computers\)/);
});
