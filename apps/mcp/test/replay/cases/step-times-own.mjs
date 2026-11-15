import assert from "node:assert/strict";
import graphLib from "../../../../../packages/shared/src/texGraph.cjs";
import { eventEntry, nodeLog } from "../../../src/agent/ledger.js";

const { createGraph } = graphLib;
const node = (id) => ({ id, on: true, rounds: 1 });
const wire = (from, to, mode = "wait") => ({ from, to, mode, when: ["*"] });

export default {
  id: "step-times-own",
  incident: "2026-11-15: replaying a 1:1 turn in the Lab, Text them, Answer checks, Memory nudge and Reflect all showed 0 s.",
  cause: "Text them's delivery runs in the texting Worker after the gateway answers and was never logged, so Replay drew it as the reply less the other steps; the front door was counted twice (rounds and node runs) and Answer checks' run held the front door's rewrite, so that remainder fell to 0.",
  path: "1:1 text",
  async run() {
    let clock = 0;
    const written = [];
    const config = { nodes: [node("fd"), node("checks"), node("send")], edges: [wire("fd", "checks"), wire("checks", "send"), { ...wire("checks", "fd", "loop"), rounds: 2 }] };
    let backs = 0;
    const g = createGraph(
      config,
      {
        fd: async () => ((clock += 4_500), {}),
        checks: async (_x, io) => ((clock += 2), backs++ === 0 && (await io.back.fd({})), {}),
        send: async () => ((clock += 1), {}),
      },
      { log: nodeLog({ write: (e) => written.push(e) }, { turn: "turn-replay-0002" }), now: () => clock },
    );
    await g.run("fd", {});
    const checks = written.find((e) => e.name === "checks");
    assert.equal(checks.ms, 4_502, "Answer checks' whole run holds the rewrite it sent back for");
    assert.equal(checks.own, 2, "but its own time is its code alone, so Replay never shows the front door's time as its");
    const delivery = eventEntry({ id: "1794772822042-001207", at: 1794772822042, kind: "step", chat: "texts", turn: "turn-replay-0002", step: { name: "send", of: "delivery", ok: true, ms: 470, input: { parts: 1 }, output: { sent: 1 } } });
    assert.deepEqual([delivery.step, delivery.name, delivery.turn, delivery.ms], ["send", "delivery", "turn-replay-0002", 470], "Text them's delivery is kept under its turn, with its time");
  },
};
