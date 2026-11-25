/**
 * The Nudge step (`nudgeOffer`; Dev and Seyi, 2026-11-24): one offer line after a finished 1:1 answer, each capability
 * offered once, traced per run and counted for retention. Decision: docs/decisions/texting-assistant/nudges.md.
 *
 * Sabotage record (temporary local edits, reverted, 2026-11-24):
 *   nudges.js checkedVerdict skipping the "already offered" check   "a capability is offered once, ever" fails
 *   nodes/finish.js adding the line whatever `sent` says           "a shadow run adds nothing" fails
 *   nodes/nudgeOffer.js turnGate letting a group through            "a group chat is never nudged" fails
 *   texConfig.json nudgeOffer "on": true                            "off on main" fails
 *   texConfig.json finish outSchema without "nudged"               "Finish the text's row with the line added fits its schema" fails
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TEX_CONFIG } from "../../../packages/tex/gateway/agent/texConfig.js";
import { stepSettings } from "../../../packages/tex/src/texNodeSettings.cjs";
import { finishNode, withNudgeLine } from "../../../packages/tex/gateway/agent/graph/nodes/finish.js";
import nudgeOffer, { turnGate } from "../../../packages/tex/gateway/agent/graph/nodes/nudgeOffer.js";
import { GATEWAY_NODES } from "../../../packages/tex/gateway/agent/graph/gatewayNodes.js";
import { NUDGES_PATH, OFFERABLE, checkedVerdict, gateOf, nudgePoints, nudgeQuestion, parseState, settlePending, toolsUsed } from "../../../packages/tex/gateway/agent/nudges.js";
import { LAB_SANDBOX_KEY } from "../src/labSandbox/policy.js";
import { checkShape } from "../../../packages/tex/src/texGraph.cjs";

const node = (id) => TEX_CONFIG.nodes.find((n) => n.id === id);
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const CAL = "Calendar";

/** A Lab draft of main with the Nudge on and `settings` on it. */
function draftOn(settings = {}) {
  const draft = JSON.parse(JSON.stringify(TEX_CONFIG));
  const step = draft.nodes.find((n) => n.id === "nudgeOffer");
  step.on = true;
  step.settings = { ...step.settings, ...settings };
  return draft;
}

/** A store holding the nudge record in memory. */
function memoryStore(initial = null) {
  const files = new Map(initial === null ? [] : [[NUDGES_PATH, JSON.stringify(initial)]]);
  return {
    files,
    get: async (key) => (files.has(key) ? { text: async () => files.get(key) } : null),
    put: async (key, text) => void files.set(key, text),
  };
}

/** The model's answer through the AI gateway, as the gateway returns a tool call. */
const reply = (args, seen = []) => async (_url, init) => {
  seen.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "n", name: "nudge", input: args }], stop_reason: "tool_use" }), { headers: { "content-type": "application/json" } });
};

/** A 1:1 turn at Finish, with `answer` finished. */
function turn({ answer = "Dinner Saturday at 8 is in your notes.", group = null, store = memoryStore(), config = draftOn(), points = [] } = {}) {
  const env = { TEX_NUDGES: { writeDataPoint: (p) => points.push(p) } };
  return {
    t: { env, chatTurn: true, group, job: null, report: null, routine: null, runner: false, crossChat: null, question: "dinner with Ada saturday at 8, remind me", history: [], ledger: { asked: [], offered: null }, session: { workspaceId: "ws_test" }, store, finished: { answer, sent: answer } },
    config,
    points,
  };
}

/** Run the node with the Nudge's settings from `config` (the step reads its config through `settingsOf`, from env). */
async function runNudge(t, config, fetchImpl) {
  const env = config === TEX_CONFIG ? t.env : { ...t.env, [LAB_SANDBOX_KEY]: { record: () => {}, config, kvGet: null } };
  // Without a sandbox gate the store is the person's; a draft config rides on a gate only in a Lab test chat, so the
  // test keeps the store path by handing the draft through a gate whose kv is the same memory store.
  if (config !== TEX_CONFIG) {
    const files = t.store.files;
    env[LAB_SANDBOX_KEY].kvGet = async (_obj, key) => (files.has(key) ? { body: btoa(unescape(encodeURIComponent(files.get(key)))) } : null);
    env[LAB_SANDBOX_KEY].kvPut = async (_obj, key, { body }) => void files.set(key, decodeURIComponent(escape(atob(body))));
  }
  return nudgeOffer({ chars: t.finished.answer.length }, { ctx: { turn: { ...t, env }, gateway: { accountId: "a", gatewayId: "g", token: "t" }, fetchImpl, now: NOW } });
}

test("the Nudge is a step of Tex's config, off on main, wired from Finish the text", () => {
  const step = node("nudgeOffer");
  assert.ok(step, "nudgeOffer is a node");
  assert.equal(step.on, false, "off on main: today's behaviour, no nudges");
  assert.equal(step.log, true, "every run is a row in the chat's record");
  assert.ok(TEX_CONFIG.edges.some((e) => e.from === "finish" && e.to === "nudgeOffer" && e.mode === "uses"), "finish -> nudgeOffer, uses");
  assert.equal(typeof GATEWAY_NODES.nudgeOffer, "function", "the gateway has its code");
  assert.deepEqual(stepSettings(TEX_CONFIG, "nudgeOffer"), { addLine: true, minTexts: 5, cooldownHours: 24 });
});

test("the capabilities it may offer are the capability list's 1:1 lines, by name", () => {
  assert.ok(OFFERABLE.length > 20);
  assert.ok(OFFERABLE.some((c) => c.name === CAL));
  assert.equal(checkedVerdict({ offer: true, capability: "Teleport", line: "Want me to?", why: "x" }, parseState("{}", NOW)).offer, false, "a name not on the list is no offer");
});

test("a capability is offered once, ever, and a bad line is no offer", () => {
  const state = { v: 1, firstAt: NOW - 9 * DAY, texts: 20, offers: [{ capability: CAL, at: NOW - 5 * DAY, outcome: "declined" }] };
  assert.equal(checkedVerdict({ offer: true, capability: CAL, line: "Want me to see your calendar?", why: "a plan" }, state).offer, false);
  const fresh = parseState(null, NOW);
  assert.equal(checkedVerdict({ offer: true, capability: CAL, line: "x".repeat(400), why: "" }, fresh).offer, false, "too long");
  assert.equal(checkedVerdict({ offer: true, capability: CAL, line: "See https://evil.example", why: "" }, fresh).offer, false, "no links");
  assert.equal(checkedVerdict({ offer: true, capability: CAL, line: "Want me to see your calendar?", why: "a plan" }, fresh).offer, true);
});

test("gates: first texts, then the cooldown", () => {
  const settings = { minTexts: 5, cooldownHours: 24 };
  assert.equal(gateOf({ texts: 3, offers: [] }, NOW, settings), "habit");
  assert.equal(gateOf({ texts: 9, offers: [{ capability: CAL, at: NOW - 3_600_000 }] }, NOW, settings), "cooldown");
  assert.equal(gateOf({ texts: 9, offers: [{ capability: CAL, at: NOW - 2 * DAY }] }, NOW, settings), null);
});

test("a group chat is never nudged, and nothing is read or counted for it", async () => {
  const { t } = turn({ group: { from: "x" } });
  assert.equal(turnGate(t), "not1to1");
  let read = false;
  t.store.get = async () => { read = true; return null; };
  const out = await runNudge(t, draftOn(), reply({ offer: true, capability: CAL, line: "?", why: "" }));
  assert.deepEqual([out.to, out.gate, read], ["skip", "not1to1", false]);
});

test("an answer that asks for a yes gets no offer beside it", () => {
  const { t } = turn({ answer: "Should I book it?" });
  assert.equal(turnGate(t), "asking");
  const held = turn();
  held.t.ledger.asked = [{ id: "a" }];
  assert.equal(turnGate(held.t), "asking");
});

test("an offer: the row says why, the record keeps it, a point is counted, and the next text reads their answer", async () => {
  const points = [];
  const store = memoryStore({ v: 1, firstAt: NOW - 10 * DAY, texts: 8, offers: [] });
  const { t, config } = turn({ store, points });
  const seen = [];
  const out = await runNudge(t, config, reply({ offer: true, capability: CAL, line: "Want me to see your calendar? Then I can tell you when you're free.", why: "a plan with a time" }, seen));
  assert.equal(out.to, "offer");
  assert.equal(out.sent, true);
  assert.equal(out.capability, CAL);
  assert.equal(out.why, "a plan with a time");
  assert.match(seen[0].system?.[0]?.text ?? JSON.stringify(seen[0].system), /HOW TEX WORKS/, "the model is given the map and the capability list");
  const kept = JSON.parse(store.files.get(NUDGES_PATH));
  assert.equal(kept.offers.at(-1).outcome, "pending");
  assert.deepEqual(points[0].blobs, ["offer", CAL, "", "sent"]);
  assert.deepEqual(points[0].indexes, ["ws_test"]);

  // Their next text says no: inside the cooldown, so no new offer, and the answer is kept and counted.
  const next = turn({ store, points });
  next.t.question = "nah I don't want you in my calendar";
  const after = await runNudge(next.t, config, reply({ offer: false, last_offer: "declined", why: "they said no" }));
  assert.equal(after.to, "skip");
  assert.equal(after.gate, "cooldown");
  assert.deepEqual(after.answered, { capability: CAL, said: "declined" });
  assert.equal(JSON.parse(store.files.get(NUDGES_PATH)).offers.at(-1).outcome, "declined");
  assert.deepEqual(points.at(-1).blobs, ["answer", CAL, "declined", "sent"]);
});

test("an offer nobody answers is ignored after three texts", () => {
  const pending = { capability: CAL, at: NOW, outcome: "pending" };
  assert.equal(settlePending(pending, "not_about_it", NOW), null);
  assert.equal(settlePending(pending, null, NOW), null);
  assert.equal(settlePending(pending, "not_about_it", NOW), "ignored");
  assert.equal(pending.outcome, "ignored");
});

test("a shadow run (Add the line off) decides and keeps the same, and Finish adds nothing", async () => {
  const store = memoryStore({ v: 1, firstAt: NOW - 10 * DAY, texts: 8, offers: [] });
  const { t } = turn({ store });
  const out = await runNudge(t, draftOn({ addLine: false }), reply({ offer: true, capability: CAL, line: "Want me to see your calendar?", why: "a plan" }));
  assert.equal(out.to, "offer");
  assert.equal(out.sent, false);
  assert.equal(JSON.parse(store.files.get(NUDGES_PATH)).offers.at(-1).outcome, "shadow", "kept, so once-only and the cooldown hold in a shadow run too");

  assert.equal(withNudgeLine({ answer: "Done.", sent: "Done.\n\nhttps://link" }, "Want me to?").sent, "Done.\n\nWant me to?\n\nhttps://link", "the line goes before a hand-off link");
});

test("Finish the text adds the Nudge's line only when it was sent, and never calls it while it is off", async () => {
  const run = async (said, on = true) => {
    let called = false;
    const t = { env: {}, turn: { answer: "Saturday at 8 works.", steps: [], timing: {} }, drafts: {}, group: null, job: null, report: null, runner: false, claims: null, setAside: [], ledger: { asked: [], offered: null }, outgoing: { take: (words) => ({ answer: words, pictures: [], captions: [] }) }, tex: { step: (_n, f) => f() }, opened: null, noteLinking: null, store: null, session: null };
    const out = await finishNode({}, { on: () => on, use: { nudgeOffer: async () => { called = true; return said; } }, ctx: { turn: t } });
    return { out, sent: t.finished.sent, called };
  };
  const line = "Want me to see your calendar? Then I can tell you when you're free.";
  const sent = await run({ to: "offer", sent: true, line });
  assert.equal(sent.sent, `Saturday at 8 works.\n\n${line}`);
  assert.equal(sent.out.nudged, true);
  assert.equal((await run({ to: "offer", sent: false, line })).sent, "Saturday at 8 works.", "a shadow run adds nothing");
  const off = await run({ to: "offer", sent: true, line }, false);
  assert.deepEqual([off.sent, off.called], ["Saturday at 8 works.", false], "off: never asked");
});

test("a point carries names and counts only", () => {
  const [point] = nudgePoints({ workspace: "ws_1", event: "none", sent: true, state: { firstAt: NOW - 3 * DAY, texts: 12, offers: [] }, now: NOW, modelMs: 420 });
  assert.deepEqual(point.blobs, ["none", "", "", "sent"]);
  assert.deepEqual(point.doubles, [12, 3, 420, -1]);
});

test("Finish the text's row with the line added fits its schema (a Lab test chat's turn failed on \"nudged\", 2026-11-25)", () => {
  assert.doesNotThrow(() => checkShape("finish", "output", { when: ["finished"], chars: 40, asked: 0, silent: false, nudged: true }, node("finish").outSchema));
});

test("the model is told which tools the turn used, so it never offers what they already have", () => {
  const used = toolsUsed([{ tool: "calendar_event", ok: true }, { tool: "read_calendar" }, { name: "send", action: "email" }, { tool: "calendar_event" }]);
  assert.deepEqual(used, ["calendar_event", "read_calendar", "send.email"]);
  const words = nudgeQuestion({ question: "dinner sat 8", answer: "Added.", recent: [], tainted: false, offered: [], pending: null, offerOpen: true, used });
  assert.match(words, /<used>\ncalendar_event, read_calendar, send.email\n<\/used>/);
});
