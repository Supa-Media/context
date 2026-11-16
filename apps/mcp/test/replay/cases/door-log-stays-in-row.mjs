import assert from "node:assert/strict";

import graphLib from "../../../../../packages/shared/src/texGraph.cjs";
import { TEX_CONFIG as MAIN, withDraft } from "../../../src/agent/texConfig.js";
import { DOOR_PARTS, runDoor } from "../../../src/agent/graph/door.js";
import { doorOutput } from "../../../src/agent/graph/nodes/doorStep.js";
import DRAFT from "../../fixtures/simplerGraphDraft.json" with { type: "json" };

const { createGraph } = graphLib;

export default {
  id: "door-log-stays-in-row",
  incident: "2026-11-16: the simpler-graph Lab draft scored 0/20 on the Front door's Dev set tests; every turn failed before the Front door ran.",
  cause: "The Door step handed its parts log on with what it found, and the Front door's strict input shape refused the field it does not name.",
  path: "1:1 text",
  async run() {
    const config = withDraft(MAIN, DRAFT);
    const t = { question: "When's my dentist appointment?", session: {}, texted: true };
    const door = await runDoor(t, {}, () => 0, DOOR_PARTS.map(([name, , found]) => [name, async () => undefined, found]));
    const got = [];
    const written = [];
    const impls = { doorStep: async () => doorOutput(door), fd: async (input) => (got.push(input), { when: [] }), answerCheck: async () => ({ when: [] }), send: async () => ({ when: [] }) };
    // The Front door's own input shape; the stand-ins' outputs are not what this case is about.
    const shaped = { ...config, nodes: config.nodes.map((n) => ({ ...n, outSchema: undefined, ...(n.id === "fd" ? {} : { inSchema: undefined }) })) };
    await createGraph(shaped, impls, { log: (entry) => written.push(entry) }).run("doorStep", {}, {});
    assert.equal(got.length, 1, "the Front door ran on the text");
    assert.ok(!("log" in got[0]) && !("parts" in got[0]), "and was handed only what the Door found");
    const row = written.find((entry) => entry.node === "doorStep");
    assert.ok(row?.output?.log?.parts?.length === DOOR_PARTS.length, "every part is still in the Door's own row");
  },
};
