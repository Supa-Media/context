import assert from "node:assert/strict";
import { gatewayGraph } from "../../../src/agent/graph/gatewayGraph.js";

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
    // Reflect and the nudge after a reply: a turn that may not write skips both, and still logs that it ran.
    const ctx = { env: {}, controlPlane: null, store: { contexts: [{ current: true, kind: "personal" }] }, session: { actorClientId: "context_texts", workspaceId: "w-replay" }, offered: [], turn: { answer: "ok", steps: [] }, learned: null, timeZone: "America/New_York" };
    assert.deepEqual(await graph.fire("send", "reflect", { question: "thanks", tainted: false, ownText: true, canWrite: false }, ctx), { outcome: "skipped" });
    assert.deepEqual(await graph.fire("send", "nudge", { question: "thanks", answer: "ok", tainted: false, canWrite: false }, ctx), { outcome: "skipped" });
    // A step with no wire from its caller is refused, so code cannot reach a node the config does not wire to it.
    await assert.rejects(graph.fire("send", "egress", { words: "share it", action: "share" }, ctx), /no wire/);
    const nodes = written.filter((entry) => entry.kind === "step" && entry.step === "node");
    assert.deepEqual(nodes.map((entry) => entry.name), ["card", "picture", "reflect", "nudge"], "every run is a node step in the chat's record");
    assert.ok(nodes.every((entry) => entry.turn === "turn-replay-0002" && entry.ok === true), "under the turn, each one ok");
  },
};
