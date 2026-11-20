/**
 * Job start (Dev2, 2026-11-17, jobs as config, step 7): whether a background job the front door asks for starts now,
 * as one pure rule (`packages/shared/src/jobStart.cjs`) behind the shelf node `jobStart`, with its slots as config.
 *
 * Sabotage record (temporary local edits, reverted):
 *   decideStart's `already` check removed → "the same job as one running is steered, not started twice" fails
 *   decideStart's `busy >= room` check removed → "a full place waits" fails
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { jobStartNode } from "../../../packages/tex/gateway/agent/graph/nodes/jobStart.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { jobStartChooser } from "../../../packages/tex/gateway/agent/jobStartChoice.js";
import { MAX_CLOUD_JOBS, MAX_MACHINE_SLOTS } from "../../../packages/tex/gateway/agent/jobSlots.js";
import { backgroundSession } from "../../../packages/tex/gateway/agent/background.js";
import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";

const require = createRequire(import.meta.url);
const { DEFAULT_LIMITS, configStartLimits, decideStart } = require("../../../packages/shared/src/jobStart.cjs");
const SHELF = require("../../../packages/tex/src/texNodeShelf.json");
const ask = (fields = {}) => ({ hasTitle: true, hasBrief: true, already: null, computer: null, cloudBusy: 0, machineBusy: 0, ...fields });

test("a job with a title and a brief starts where there is a free slot", () => {
  assert.deepEqual(decideStart(ask()), { to: "start", where: "cloud", slots: 3 });
  assert.deepEqual(decideStart(ask({ computer: { id: "m1", slots: 4 }, machineBusy: 3 })), { to: "start", where: "computer", slots: 4 });
});

test("an ask with no title or no brief is refused", () => {
  assert.equal(decideStart(ask({ hasTitle: false })).to, "refuse");
  assert.equal(decideStart(ask({ hasBrief: false })).to, "refuse");
  assert.equal(decideStart(null).to, "refuse");
});

test("the same job as one running is steered, not started twice", () => {
  assert.deepEqual(decideStart(ask({ already: { title: "Find ramen", startedAt: 5, status: "reading menus" } })), { to: "already", title: "Find ramen", startedAt: 5, status: "reading menus" });
});

test("a full place waits: the cloud's slots, or the computer's own, never over the limit", () => {
  assert.deepEqual(decideStart(ask({ cloudBusy: 3 })), { to: "full", where: "cloud", slots: 3 });
  assert.equal(decideStart(ask({ computer: { id: "m1" }, machineBusy: 1 })).to, "full", "a computer naming no slots has one");
  assert.deepEqual(decideStart(ask({ computer: { id: "m1", slots: 20 }, machineBusy: 8 })), { to: "full", where: "computer", slots: 8 });
  assert.equal(decideStart(ask({ cloudBusy: 3 }), { cloudSlots: 5 }).to, "start", "the node's config sets the slots");
});

test("the limits are today's numbers, and everything that counts slots reads them", () => {
  assert.deepEqual(DEFAULT_LIMITS, { cloudSlots: 3, machineSlots: 8 });
  assert.deepEqual(configStartLimits({ nodes: [{ id: "jobStart", limits: { cloudSlots: 4, machineSlots: -1 } }] }), { cloudSlots: 4, machineSlots: 8 });
  assert.equal(MAX_CLOUD_JOBS, configStartLimits(TEX_CONFIG).cloudSlots);
  assert.equal(MAX_MACHINE_SLOTS, configStartLimits(TEX_CONFIG).machineSlots);
});

test("the node answers its choice as a when tag, under the limits on its own config", async () => {
  assert.deepEqual(await jobStartNode(ask({ cloudBusy: 3 }), { node: { limits: { cloudSlots: 4 } } }), { when: ["start"], to: "start", where: "cloud", slots: 4 });
  assert.equal(GATEWAY_NODES.jobStart, jobStartNode);
});

test("wired in the config (off the shelf), with today's slots; a config without it lets the rule decide, no node run", async () => {
  assert.ok(!SHELF.nodes.jobStart, "off the shelf once promoted");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "fd" && e.to === "jobStart" && e.mode === "uses"), "the fd -> jobStart wire");
  assert.deepEqual(configStartLimits(TEX_CONFIG), DEFAULT_LIMITS, "today's slots, now from the node's config");
  const entries = [];
  const unwired = { ...TEX_CONFIG, nodes: TEX_CONFIG.nodes.filter((n) => n.id !== "jobStart"), edges: TEX_CONFIG.edges.filter((e) => e.to !== "jobStart") };
  const choose = jobStartChooser({ config: unwired, writer: { write: (e) => entries.push(e) } });
  assert.deepEqual(await choose(ask()), decideStart(ask()));
  assert.equal(entries.length, 0);
});

test("once the config has it, each start asks the node, logged", async () => {
  const node = { id: "jobStart", label: "Job start", goal: "x", model: "code", group: "jobs", on: true, limits: { cloudSlots: 1 }, inSchema: [{ name: "hasTitle", type: "yesno" }, { name: "hasBrief", type: "yesno" }, { name: "already", type: "object", optional: true }, { name: "computer", type: "object", optional: true }, { name: "cloudBusy", type: "number", optional: true }, { name: "machineBusy", type: "number", optional: true }], outSchema: [{ name: "to", type: "choice", options: "start, already, full, refuse" }, { name: "where", type: "text", optional: true }, { name: "slots", type: "number", optional: true }, { name: "title", type: "text", optional: true }, { name: "startedAt", type: "number", optional: true }, { name: "status", type: "text", optional: true }, { name: "why", type: "text", optional: true }] };
  const config = { ...TEX_CONFIG, nodes: [...TEX_CONFIG.nodes.filter((n) => n.id !== "jobStart"), node] };
  const entries = [];
  const choose = jobStartChooser({ config, writer: { write: (e) => entries.push(e) } });
  assert.equal((await choose(ask({ cloudBusy: 1 }))).to, "full", "the node's own limits");
  assert.equal(entries.length, 1);
});

test("the job tool follows the choice: a start, a steer to the running job, a full cloud", async () => {
  const run = (choice, running = []) => backgroundSession({ running, job: null, now: 1_000, chooseStart: async () => choice });
  const words = (r) => r.content.map((p) => p.text).join(" ");
  const started = run({ to: "start", where: "cloud", slots: 3 });
  assert.match(words(await started.call({ title: "Find ramen", brief: "three near Union Square" })), /Started in the background/);
  assert.equal(started.started.length, 1);
  assert.match(words(await run({ to: "already", title: "Find ramen" }).call({ title: "Find ramen", brief: "x" })), /Already working on that/);
  const full = await run({ to: "full", where: "cloud", slots: 5 }).call({ title: "Find ramen", brief: "x" });
  assert.equal(full.isError, true);
  assert.match(words(full), /^5 jobs are already running/);
  assert.match(words(await run({ to: "refuse" }).call({ title: "", brief: "" })), /needs a title and a brief/);
});
