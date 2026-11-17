/**
 * A provisional wire keeps the privacy holds `firstLook` and `sms` (2026-11-17).
 * They are config (`unless`), so a Lab Promote or a hand edit of texConfig.json could drop one and start the door
 * early on a chat Tex is not set up in, or on an SMS. The config check refuses that, names the wire and the hold,
 * and logs it. The same check runs for the committed config (CI, `configProblems`) and for a Lab draft on its way
 * to Promote (`configFrom`, and `draftProblems` for tex_dev). `unpaired` may be absent. The runner is unchanged:
 * a valid config still runs as it does.
 *
 * Sabotage: `provisionalHoldProblems` returns [] — (b), (c) and the Promote refusal fail, and nothing is logged.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import schema from "../../../packages/shared/src/texConfigSchema.cjs";
import { TEX_CONFIG } from "../src/agent/texConfig.js";
import { draftProblems } from "../src/texDev/check.js";
import { configFrom } from "../../../scripts/tex-lab-promote.mjs";
import { wordsOf } from "../../../scripts/tex-prompt-module.mjs";

const { configProblems } = schema;

const clone = (value) => JSON.parse(JSON.stringify(value));
const hold = (from, to, fact) => `provisional wire ${from} → ${to} is missing the hold ${fact}`;

/** Production's graph with one provisional wire's `unless` losing `fact`. */
function dropped(from, fact) {
  const config = clone(TEX_CONFIG);
  const wire = config.edges.find((e) => e.from === from && e.mode === "provisional");
  wire.unless = wire.unless.filter((f) => f !== fact);
  return config;
}

/** `run` with `console.log` captured. The check is synchronous; the lines are its own. */
function logged(run) {
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return { result: run(), lines };
  } finally {
    console.log = log;
  }
}

function loggedRefusal(lines, from, fact) {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((row) => row && row.event === "provisional_hold_refused" && row.from === from && row.missing === fact);
}

test("the production config passes, and unpaired may be absent", () => {
  assert.deepEqual(configProblems(TEX_CONFIG), []);
  const config = clone(TEX_CONFIG);
  for (const edge of config.edges) if (edge.mode === "provisional") edge.unless = ["firstLook", "sms"];
  assert.deepEqual(configProblems(config), []);
  assert.deepEqual(draftProblems({ nodes: config.nodes, edges: config.edges }), []);
});

test("a provisional wire missing firstLook is refused, and the refusal is logged", () => {
  const { result, lines } = logged(() => configProblems(dropped("triage", "firstLook")));
  assert.ok(result.includes(hold("triage", "doorStep", "firstLook")));
  assert.equal(result.some((p) => p.includes(hold("triage", "doorStep", "sms"))), false);
  assert.deepEqual(loggedRefusal(lines, "triage", "firstLook"), { event: "provisional_hold_refused", from: "triage", to: "doorStep", missing: "firstLook" });
});

test("a provisional wire missing sms is refused, and the refusal is logged", () => {
  const { result, lines } = logged(() => configProblems(dropped("decide", "sms")));
  assert.ok(result.includes(hold("decide", "doorStep", "sms")));
  assert.equal(result.some((p) => p.includes(hold("decide", "doorStep", "firstLook"))), false);
  assert.deepEqual(loggedRefusal(lines, "decide", "sms"), { event: "provisional_hold_refused", from: "decide", to: "doorStep", missing: "sms" });
});

test("a Lab Promote draft that drops a hold is refused, and tex_dev refuses it too", async () => {
  const words = wordsOf();
  const graph = clone({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges });
  graph.edges.find((e) => e.from === "lanes" && e.mode === "provisional").unless = ["firstLook", "unpaired"];
  const { result, lines } = logged(() => configFrom(graph, TEX_CONFIG, words));
  assert.match(result.refused ?? "", new RegExp(hold("lanes", "doorStep", "sms").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(loggedRefusal(lines, "lanes", "sms"), { event: "provisional_hold_refused", from: "lanes", to: "doorStep", missing: "sms" });

  const problems = draftProblems(graph);
  assert.ok(problems.includes(hold("lanes", "doorStep", "sms")));
});

test("tex_dev promote refuses a draft that drops a hold and does not ask for it", async () => {
  const graph = clone({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges });
  graph.edges.find((e) => e.from === "lanes" && e.mode === "provisional").unless = ["firstLook", "unpaired"];
  const { createTexDev } = await import("../src/texDev/tool.js");
  const plane = {
    calls: [],
    async texDev(_token, action, args) {
      this.calls.push({ action, args });
      return action === "get" ? { status: "ok", rev: 2, graph: JSON.stringify(graph) } : { status: "ok" };
    },
  };
  const session = {
    workspaceId: "ws_mine",
    workspaces: [
      { workspaceId: "ws_mine", slug: "mine", role: "owner", kind: "personal" },
      { workspaceId: "ws_pin", slug: "context-lc", role: "editor", kind: "shared" },
    ],
    scopes: ["context:read", "context:write", "context:private"],
    grantScopes: ["context:read", "context:write", "context:private"],
    actorUserId: "user_test",
    accessToken: "tok",
  };
  const refused = await createTexDev({ env: {}, session, controlPlane: plane })("promote", { draft: "vabc" });
  assert.equal(refused.isError, true);
  assert.match(refused.content.find((c) => c.type === "text")?.text ?? "", /lanes → doorStep is missing the hold sms/);
  assert.equal(plane.calls.some((c) => c.action === "promote"), false);
});
