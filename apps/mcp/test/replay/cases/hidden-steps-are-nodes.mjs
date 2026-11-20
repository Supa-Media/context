import assert from "node:assert/strict";
import graphLib from "../../../../../packages/tex/src/texGraph.cjs";
import { gatewayGraph } from "../../../../../packages/tex/gateway/agent/graph/gatewayGraph.js";
import { TEX_CONFIG as MAIN, withDraft } from "../../../../../packages/tex/gateway/agent/texConfig.js";
import { DOOR_PARTS, runDoor } from "../../../../../packages/tex/gateway/agent/graph/door.js";
import { doorOutput } from "../../../../../packages/tex/gateway/agent/graph/nodes/doorStep.js";
import DRAFT from "../../fixtures/simplerGraphDraft.json" with { type: "json" };

/** A picture as a draw tool answers it, the bytes stand-ins. */
const drawn = { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] };

export default {
  id: "hidden-steps-are-nodes",
  incident: "2026-11-14: Dev2 audited what runs in a Tex turn and found steps with no node in the config: the egress judge, the picture maker and its card check, Reflect and the memory nudge after the reply, and the nightly dream, day summaries and housekeeping.",
  cause: "Each was called straight from code, so the config could not show, switch or rewire it and nothing logged it as a step; the drawing showed less than ran.",
  path: "1:1 text",
  async run() {
    const written = [];
    const writer = { write: (entry) => written.push(entry), flush: async () => {} };
    const graph = gatewayGraph({ writer, turn: "turn-replay-0002" });
    // A picture goes out only after Card check looked, and both are node steps under the turn.
    const looked = [];
    const maker = { call: async (_name, args, _callTool, { check }) => (looked.push(await check({ tool: "draw_picture", template: args.template, picture: { data: "aGVsbG8=", mediaType: "image/png" }, unpinned: [] })), drawn) };
    const out = await graph.fire("tools", "picture", { tool: "draw_picture", args: { template: "" } }, { maker, callTool: async () => null, cardCheck: async () => ({ send: true, critique: "" }) });
    assert.deepEqual(out.result, drawn);
    assert.deepEqual(looked, [{ send: true, critique: "" }], "the card check ran inside the picture maker, through its wire");
    // Reflect and the nudge after a reply, one Learn step since 2026-11-16: a turn that may not write skips both halves, and still logs that it ran.
    const ctx = { env: {}, controlPlane: null, store: { contexts: [{ current: true, kind: "personal" }] }, session: { actorClientId: "context_texts", workspaceId: "w-replay" }, offered: [], turn: { answer: "ok", steps: [] }, learned: null, timeZone: "America/New_York" };
    assert.deepEqual(await graph.fire("send", "learn", { question: "thanks", answer: "ok", tainted: false, ownText: true, canWrite: false }, ctx), { nudge: { outcome: "skipped" }, reflect: { outcome: "skipped" } });
    // A step with no wire from its caller is refused, the old Reflect step among them, so code cannot reach a node the config does not wire to it.
    await assert.rejects(graph.fire("send", "egress", { words: "share it", action: "share" }, ctx), /no wire/);
    await assert.rejects(graph.fire("send", "reflect", { question: "thanks", tainted: false, ownText: true, canWrite: false }, ctx), /no wire/);
    const nodes = written.filter((entry) => entry.kind === "step" && entry.step === "node");
    assert.deepEqual(nodes.map((entry) => entry.name), ["card", "picture", "learn"], "every run is a node step in the chat's record");
    assert.ok(nodes.every((entry) => entry.turn === "turn-replay-0002" && entry.ok === true), "under the turn, each one ok");
    // 2026-11-16: the Door, one step on the simpler graph, handed its parts log on with what it found, and the Front
    // door's strict input shape refused it, so every Dev set text failed (0/20). A step's `log` stays in its own row.
    const draft = withDraft(MAIN, DRAFT);
    const door = await runDoor({ question: "When's my dentist appointment?", session: {}, texted: true }, {}, () => 0, DOOR_PARTS.map(([name, , found]) => [name, async () => undefined, found]));
    const fed = [];
    const rows = [];
    const shapes = { ...draft, nodes: draft.nodes.map((n) => ({ ...n, outSchema: undefined, ...(n.id === "fd" ? {} : { inSchema: undefined }) })) };
    const stand = { doorStep: async () => doorOutput(door), fd: async (input) => (fed.push(input), { when: [] }), answerCheck: async () => ({ when: [] }), send: async () => ({ when: [] }) };
    await graphLib.createGraph(shapes, stand, { log: (entry) => rows.push(entry) }).run("doorStep", {}, {});
    assert.equal(fed.length, 1, "the Front door ran on the text, its own input shape checked");
    assert.ok(!("log" in fed[0]) && !("parts" in fed[0]), "handed only what the Door found");
    assert.equal(rows.find((entry) => entry.node === "doorStep")?.output?.log?.parts?.length, DOOR_PARTS.length, "every part still in the Door's row");
  },
};
