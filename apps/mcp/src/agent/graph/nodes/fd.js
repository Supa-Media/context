/**
 * Front door node "fd" (`texConfig.json`): writes Tex's answer with every tool. Its code is the door's model step,
 * `../../texEntryPoint/runTheModel.js`, which runs `turn.js` `runTurn`.
 *
 * What it reaches, it reaches through its wires: each tool call through `io.use.tools`, the advisor through
 * `io.use.advisor`, the fallback model through `io.use.fallback`, the big-ask planner through `io.use.planner`. It never
 * checks its own drafts: it stops at each one (`../draftBridge.js`) and returns it, and the config's wires take it to
 * Answer checks and the Reply reviewer, whose `loop` wires (`io.back.fd`) bring it back here with their notice, `null`
 * when the draft may go. A turn the model step ended itself (a refusal beside the model, a cancel) leaves its answer in
 * `t.response` and says `ended`.
 */
import { ADVISOR_TOOL } from "../../advisor.js";
import { runTheModel } from "../../texEntryPoint/runTheModel.js";
import { draftBridge } from "../draftBridge.js";

/** A stop of the model loop as this node's output: a draft waiting on its checks, or the turn done. */
function stopOutput(t, stop) {
  if (stop.paused) return { when: ["drafted"], pending: true, draftChars: String(stop.draft ?? "").length, actions: actionsIn(stop.info) };
  if (stop.value !== undefined) {
    t.response = stop.value;
    return { when: ["ended"], pending: false, ended: true, status: stop.value?.status };
  }
  const turn = t.turn ?? {};
  return { when: ["done"], pending: false, draftChars: String(turn.answer ?? "").length, answeredBy: turn.model ?? undefined, steps: Array.isArray(turn.steps) ? turn.steps.length : 0, exhausted: turn.exhausted === true };
}

/** How many tool calls the turn has made by this draft: what the reviewer reads it against. */
function actionsIn(info) {
  const messages = Array.isArray(info?.messages) ? info.messages : [];
  return messages.reduce((n, m) => n + (Array.isArray(m?.toolCalls) ? m.toolCalls.length : 0), 0);
}

export async function fdNode(input, io) {
  const t = io.ctx.turn;
  if (t.drafts?.waiting) return stopOutput(t, await t.drafts.resume(input?.notice ?? null)); // back from a check, on its loop wire
  const drafts = (t.drafts = draftBridge());
  // What a call carries that the log must not (its arguments, the turn so far, its result): kept here by the call's number, and the wire carries only the number and the tool's name.
  // Each call's arguments and result are kept already, with their privacy rules, as the turn's own tool entry (`ledger.js` `toolEntry`).
  const calls = (t.toolCalls = { mcp: null, web: null, local: new Map(), held: new Map(), planner: null, fallback: null });
  let n = 0;
  const through = async (use, kind, name, args, turnSoFar) => {
    n += 1;
    const call = n;
    calls.held.set(call, { args, turnSoFar });
    try {
      await use({ kind, name, call });
      return calls.held.get(call).result;
    } finally {
      calls.held.delete(call);
    }
  };
  const via = {
    answerCheck: (draft, info) => drafts.answerCheck(draft, info),
    tools: (inner) => {
      calls.mcp = inner;
      return (name, args) => through(io.use.tools, "mcp", name, args);
    },
    web: (web) => {
      if (!web || typeof web.call !== "function") return web;
      calls.web = (name, args) => web.call(name, args);
      return Object.assign(Object.create(web), { call: (name, args) => through(io.use.tools, "web", name, args) });
    },
    local: (entries) =>
      entries.map((entry) => {
        const name = entry?.tool?.name;
        if (typeof name !== "string" || typeof entry.call !== "function") return entry;
        calls.local.set(name, entry.call);
        const call = name === ADVISOR_TOOL
          ? (args, turnSoFar) => through(io.use.advisor, "local", name, args, turnSoFar)
          : (args, turnSoFar) => through(io.use.tools, "local", name, args, turnSoFar);
        return { ...entry, call };
      }),
    fallback: (spec) => {
      if (spec === null || spec === undefined) return spec;
      calls.fallback = spec;
      return async (model) => (await io.use.fallback({ from: model }))?.model ?? null;
    },
    planner: (plan) => {
      calls.planner = plan;
      return async (args, callTool) => {
        calls.plannerTools = callTool;
        calls.plannerArgs = args;
        return (await io.use.planner({ asked: true }), calls.plannerResult);
      };
    },
  };
  const first = stopOutput(t, await drafts.start(runTheModel(t, via)));
  return { ...first, ...settingsOf(t.settings) };
}

/** The settings the turn runs the front door with (`runTheModel.js` `doorOut`), on its first output only. */
function settingsOf(settings) {
  if (!settings || typeof settings !== "object") return {};
  const { model, effort, fallback, router, reviewer, advisor, planner, computers, skills, delegation, threads } = settings;
  return { model: model ?? null, effort: effort ?? null, fallback: fallback ?? null, router, reviewer, advisor, planner, computers, skills, delegation, threads };
}
