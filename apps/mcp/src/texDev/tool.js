/**
 * `tex_dev`: developing on Tex from any MCP session (Dev2, 2026-11-15: "developers on text could use their MCPs ...
 * to continue developing on text, and have access to the rendered UI"; design
 * https://claude.ai/artifact/1nwVCYrrvYzRzJTGLYKGvk; decision docs/decisions/texting-assistant/tex-dev-tool.md).
 *
 * One tool with an `action`, offered only to a person who owns or edits `@context-lc` (`STAFF_ONLY_TOOLS`,
 * `editsPinnedContext`) and never to Tex (`WITHHELD_TOOLS`). The control plane decides again on every call that
 * reads or changes a draft or a chat (`functions/texLabDrafts.ts`). Nothing here changes live Tex: only a promoted
 * draft's pull request does, through CI and the replay gate.
 */

import { appOriginOf } from "../agent/noteLinks.js";
import { CONFIG_STAMP, draftFit, TEX_CONFIG, withDraft } from "../agent/texConfig.js";
import { toolError } from "../tools/results.js";
import { draftProblems, draftVsMain } from "./check.js";
import { ACTIONS, guideText } from "./guide.js";
import { caseRoom, labAction, labWording, putBackOps, snapshotSim } from "./lab.js";
import { chatsOf, entriesOf, openChat, turnsOf } from "./probe.js";
import { jobsAnswer, linkAnswer, mineAnswer, momentsAnswer, promptAnswer, turnAnswer } from "./replay.js";
import { nodeStatsAnswer } from "./nodeStats.js";
import { createSandboxActions } from "./sandbox.js";
import { createSetActions } from "./sets.js";
import { snapshotGraph } from "./snapshot.js";
import { createDraftWrites } from "./writes.js";
import { testSetSummary } from "../http/texTestSet.js";

export const TEX_DEV_WHO = "tex_dev is for people who edit @context-lc's AI setup.";
const UNREACHABLE = "The Lab's drafts could not be reached just now. Try again in a minute.";
/** `changes` with `wait` holds at most this long, checking this often. */
export const MAX_WAIT_S = 50;
const POLL_MS = 2_000;
const DRAFT = /^v[0-9a-z]{1,16}$/;

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });
const mainGraph = () => JSON.parse(JSON.stringify({ nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges }));

function parseGraph(text) {
  try {
    const g = typeof text === "string" ? JSON.parse(text) : text;
    return g && Array.isArray(g.nodes) && Array.isArray(g.edges) ? g : null;
  } catch {
    return null;
  }
}

/**
 * The tool's work for one connection. `call(action, args)` answers an MCP result. `env` is the gateway's, `session`
 * the connection's (its token goes to the control plane, which decides who it is), `sleep` for tests.
 */
export function createTexDev({ env, session, controlPlane, defer = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, fetch: get = (...a) => globalThis.fetch(...a), ledgerOf = undefined }) {
  const origin = appOriginOf(env) || "https://context.lc";
  const linkOf = (id) => `${origin}/lab?v=${id}`;

  async function plane(action, args = {}) {
    let answer = null;
    try {
      answer = await controlPlane.texDev(session.accessToken, action, args);
    } catch {
      answer = null;
    }
    if (answer === null) return { error: toolError(UNREACHABLE) };
    if (answer.status === "refused") return { error: toolError(TEX_DEV_WHO) };
    if (answer.status === "not_found") return { error: toolError(`There is no draft ${args.draft ?? args.from ?? ""}; list shows them.`.replace("  ", " ")) };
    if (answer.status === "bad_request") return { error: toolError(answer.error ?? "That call is not one tex_dev takes; guide lists them.") };
    return { answer };
  }

  async function draftGraph(draft) {
    const { answer, error } = await plane("get", { draft });
    if (error) return { error };
    const graph = parseGraph(answer.graph);
    return graph ? { graph, answer } : { error: toolError("This draft's graph could not be read.") };
  }

  async function page() {
    const { answer, error } = await plane("page");
    if (error) return { error };
    if (answer.status !== "ok" || typeof answer.workspaceId !== "string") return { error: toolError("Your Tex chats could not be read just now.") };
    // The chats people shared with the developers, asked again on every call so one no longer shared is gone at once
    // (`probe.js` `probedChat`); none when the control plane can't say.
    const shared = await plane("shared");
    return { page: { ...answer, shared: shared.answer?.status === "ok" && Array.isArray(shared.answer.chats) ? shared.answer.chats : [] } };
  }

  // The Lab's other writes (rename, delete, run_setup, keep_results, revert) and `get` of main (`writes.js`).
  const writes = createDraftWrites({ plane, json, linkOf });

  const needDraft = (args) => (typeof args?.draft === "string" && DRAFT.test(args.draft) ? null : toolError("Name the draft: { draft: \"v…\" } (list shows them)."));

  /** One call to the Lab's test-chat route, in this Worker, as the Lab makes it. */
  async function sandboxRoute(body) {
    const request = new Request(`${origin}/tex-lab/sandbox`, { method: "POST", headers: { authorization: `Bearer ${session.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
    // Read when asked: the route runs a whole turn, whose modules import this tool's own.
    const { handleLabSandbox } = await import("../labSandbox/route.js");
    const response = await handleLabSandbox(request, env, defer === null ? null : { waitUntil: (work) => defer(work) }, { origin });
    return { ok: response.ok, status: response.status, answer: await response.json().catch(() => ({})) };
  }

  /** The config a test chat's turn runs on: main's, or a draft over it as the sandbox runs one (`withDraft`). */
  async function sandboxGraph(versionId, drawn = null) {
    if (!versionId || versionId === "main") return { graph: { nodes: TEX_CONFIG.nodes, edges: TEX_CONFIG.edges } };
    if (drawn && typeof drawn === "object") return { graph: withDraft(TEX_CONFIG, drawn), fit: draftFit(TEX_CONFIG, drawn) };
    const { graph, error } = await draftGraph(versionId);
    if (error) return { error: "This test chat's draft could not be read." };
    return { graph: withDraft(TEX_CONFIG, graph), fit: draftFit(TEX_CONFIG, graph) };
  }

  /** A real chat's history file, for `sandbox replay`: the person's own 1:1 or a group they are in (`openChat`). */
  async function realChat(key) {
    const p = await page();
    if (p.error) return { error: "Your Tex chats could not be read just now." };
    try {
      const { place, ledger } = openChat(env, p.page, key, ...(ledgerOf ? [ledgerOf] : []));
      return ledger === null ? { error: "this chat has no history file yet" } : { ledger, name: place.name };
    } catch {
      return { error: "There is no such chat; chats lists yours." };
    }
  }

  // Named in the person's list of test chats, so the Lab shows which an AI opened and is driving (`route.js` `list`).
  const by = `AI (${String(session?.clientName ?? "MCP").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 50) || "MCP"})`;
  const sandbox = createSandboxActions({ route: sandboxRoute, graphOf: sandboxGraph, page, env, origin, realChat, by, sleep, now });

  // The Testing tab's conversations (`sets.js`): Training and Dev, never the Test Set.
  const sets = createSetActions({ plane, json, page, env, ledgerOf });

  return async function call(action, args = {}) {
    if (typeof action === "string" && (action === "sets" || action.startsWith("set_"))) {
      const answer = await sets(action, args);
      if (answer !== null) return answer;
    }
    const written = await writes(action, args);
    if (written !== null) return written;
    switch (action) {
      case "guide":
        return { content: [{ type: "text", text: guideText() }] };
      case "list": {
        const { answer, error } = await plane("list");
        return error ?? json({ drafts: answer.drafts.map((d) => ({ ...d, link: linkOf(d.id) })) });
      }
      case "create": {
        const from = args.from ?? "main";
        const graph = args.graph !== undefined ? parseGraph(args.graph) : from === "main" ? mainGraph() : null;
        if (args.graph !== undefined && graph === null) return toolError("graph must be { nodes: [...], edges: [...] }.");
        // A graph passed in is the draft (no `from`); main is sent as its graph; another draft is copied by the control plane.
        // A draft keeps the main it started from, so Promote merges only its own changes; one copied from another draft
        // keeps that draft's (the control plane copies it).
        const body = args.graph !== undefined ? { name: args.name, graph: JSON.stringify(graph), base: CONFIG_STAMP } : from === "main" ? { name: args.name, from, graph: JSON.stringify(graph), base: CONFIG_STAMP } : { name: args.name, from };
        const { answer, error } = await plane("create", body);
        return error ?? json({ draft: answer.id, rev: answer.rev, name: answer.name, link: linkOf(answer.id), next: "edit it with { action: \"edit\", args: { draft, rev, ops } }; snapshot shows it" });
      }
      case "get": {
        if (needDraft(args)) return needDraft(args);
        const { graph, answer, error } = await draftGraph(args.draft);
        if (error) return error;
        const { graph: _g, status: _s, picks, areas, results, ...about } = answer;
        const read = (text, fallback) => {
          try {
            return typeof text === "string" ? JSON.parse(text) : fallback;
          } catch {
            return fallback;
          }
        };
        // `picks`, `areas` and `results` are the Lab's Run tab: the cases picked, the areas, and every bench run's scores.
        // vsMain also names the modules' words and conversation settings the draft changes, as the Lab's nav tags do.
        return json({ ...about, link: linkOf(args.draft), vsMain: { ...draftVsMain(graph), ...labWording(args.draft, answer) }, problems: draftProblems(graph), picks: read(picks, {}), areas: read(areas, null), results: read(results, []), graph });
      }
      case "edit": {
        if (needDraft(args)) return needDraft(args);
        if (!Array.isArray(args.ops)) return toolError("edit takes ops: a list of edits (guide lists them).");
        const { answer, error } = await plane("edit", { draft: args.draft, rev: args.rev, ops: args.ops });
        if (error) return error;
        if (answer.status === "conflict") {
          return json({ refused: "someone changed the same thing first; nothing of this batch was kept", rev: answer.rev, pieces: answer.keys, now: answer.now, others: answer.others, next: `edit again against rev ${answer.rev}` });
        }
        const after = await draftGraph(args.draft);
        return json({ rev: answer.rev, kept: answer.said, others: answer.others, problems: after.graph ? draftProblems(after.graph) : null, link: linkOf(args.draft) });
      }
      case "changes": {
        if (needDraft(args)) return needDraft(args);
        const since = Number.isSafeInteger(args.since) ? args.since : 0;
        const until = now() + Math.min(MAX_WAIT_S, Math.max(0, Number(args.wait) || 0)) * 1_000;
        for (;;) {
          const { answer, error } = await plane("changes", { draft: args.draft, since });
          if (error) return error;
          if (answer.changes.length > 0 || now() + POLL_MS > until) return json({ rev: answer.rev, changes: answer.changes });
          await sleep(POLL_MS);
        }
      }
      case "snapshot": {
        let graph = null;
        let drafted = null;
        if (args.graph !== undefined) graph = parseGraph(args.graph);
        else if (typeof args.draft === "string" && args.draft !== "main") {
          const got = await draftGraph(args.draft);
          if (got.error) return got.error;
          graph = got.graph;
          drafted = got.answer;
        } else graph = mainGraph();
        if (graph === null) return toolError("snapshot takes a draft, or graph as { nodes: [...], edges: [...] }.");
        // With a test, each step carries its time and the stats chip shows, as on the Lab's canvas (`lab.js`).
        const traced = await snapshotSim(plane, args, drafted);
        if (traced.error) return traced.error;
        const shot = await snapshotGraph(env, graph, { focus: args.focus ?? null, base: mainGraph(), theme: args.theme === "light" ? "light" : "dark", sim: traced.sim });
        if (!shot.ok) return toolError(shot.error);
        return { content: [{ type: "image", data: shot.png, mimeType: "image/png" }, { type: "text", text: drafted ? `Draft ${args.draft} · live at ${linkOf(args.draft)}` : args.graph !== undefined ? "The graph you passed." : "Main as it runs today." }] };
      }
      case "link": {
        // A place in the Lab (`replay.js` `linkAnswer`): a page, or a chat and a text, as the Lab's address holds it.
        const place = args.mode !== undefined || args.page !== undefined || args.chat !== undefined || args.moment !== undefined;
        if (!place || args.draft !== undefined) {
          if (needDraft(args)) return place ? needDraft(args) : toolError("link takes a draft, or a place: { chat?, moment? } or { page }.");
          const { error } = await plane("get", { draft: args.draft });
          if (error) return error;
          if (!place) return json({ link: linkOf(args.draft), note: "Opens in the Lab with this draft live; staff sign-in. Edits you make here show there within a second, and theirs reach you in every answer." });
        }
        const p = await page();
        if (p.error) return p.error;
        const answer = await linkAnswer(p.page, args, { origin, draft: args.draft ?? null });
        return answer.error ? toolError(answer.error) : json(answer);
      }
      case "check": {
        let graph = args.graph !== undefined ? parseGraph(args.graph) : null;
        if (graph === null && typeof args.draft === "string") {
          const got = await draftGraph(args.draft);
          if (got.error) return got.error;
          graph = got.graph;
        }
        if (graph === null) return toolError("check takes a draft, or graph as { nodes: [...], edges: [...] }.");
        const problems = draftProblems(graph);
        return json({ passes: problems.length === 0, problems, vsMain: draftVsMain(graph), then: "Promote's pull request also runs CI and the replay gate." });
      }
      case "promote": {
        if (needDraft(args)) return needDraft(args);
        const got = await draftGraph(args.draft);
        if (got.error) return got.error;
        const problems = draftProblems(got.graph);
        if (problems.length > 0) return toolError(`This draft would be refused: ${problems.join("; ")}`);
        const { error } = await plane("promote", { draft: args.draft });
        return error ?? json({ promote: "asked", then: "The promote workflow starts now and opens its pull request within minutes; it merges only through CI and the replay gate. Its gate run (runs) follows the pull request's Test set status, counts only; list shows the pull request." });
      }
      // Runs on GitHub (Dev2, 2026-11-16): the Lab's Run Dev set, Run this chat and Run node, on the Dev set only.
      case "run": {
        const draft = args.draft ?? "main";
        if (draft !== "main" && needDraft({ draft })) return needDraft({ draft });
        const kind = args.kind ?? "dev";
        const { answer, error } = await plane("run", { draft, kind, conv: args.conv, node: args.node, models: args.models ?? "gw", ...(args.code !== undefined ? { code: args.code } : {}) });
        return error ?? json({ run: answer.id, stage: "queued", then: "A GitHub run starts within a minute and runs the Dev set's unit tests on the draft's code (main unless code names a pull request or branch); runs { id } shows its stage, the commit that ran and, when done, every test's verdict. The Lab's Runs panel shows the same run." });
      }
      // The code a draft runs on (Dev2, 2026-11-16: "when we run things it should run on the PRs code instead of main").
      case "code": {
        if (needDraft(args)) return needDraft(args);
        if (args.code === undefined) return toolError('code takes { draft, code: "#<pull request>" | <branch> | "main" }.');
        const { answer, error } = await plane("code", { draft: args.draft, code: args.code });
        return error ?? json({ draft: args.draft, code: answer.code ?? "main", then: answer.code ? "Every run of this draft checks this code out instead of main; runs show the commit that ran. The Lab's Code field shows the same." : "Runs of this draft are back on main's code." });
      }
      case "run_remove": {
        if (typeof args.id !== "string") return toolError("run_remove takes { id } (runs lists them).");
        const { error } = await plane("run_remove", { id: args.id });
        return error ?? json({ removed: args.id, for: "everyone: the Lab's Runs panel no longer lists it" });
      }
      case "runs": {
        const { answer, error } = await plane("runs", { draft: args.draft, id: args.id });
        return error ?? json(args.id ? answer.run : { runs: answer.runs });
      }
      case "tool_stats": {
        const { answer, error } = await plane("tool_stats", { days: args.days });
        return error ?? json(answer.stats);
      }
      // The Test Set is people only (Dev2, 2026-11-15): an agent gets what the Lab shows before "Show Test chats".
      case "test_set": {
        const summary = await testSetSummary(env);
        return summary ? json({ ...summary, note: "The Test Set's words are people only: read and written in the Lab's Testing tab. CI gates on it; tune on the Dev Set." }) : toolError("The Test Set could not be reached just now.");
      }
      case "cases": {
        const { answer, error } = await plane("cases");
        return error ?? json({ caseEdits: answer.caseEdits, note: "The bench's own cases are in apps/mcp/bench/cases/; these are the Lab's shared edits and new cases over them." });
      }
      case "case": {
        const data = args.data === null ? null : args.data !== undefined ? JSON.stringify(args.data) : undefined;
        const key = typeof args.key === "string" ? args.key : "";
        const cut = key.lastIndexOf("/");
        // A step keeps at most 20 cases (Dev2, 2026-11-15): a new one into a full step trades one out, as the
        // Tests page's swap does (`engine/caseDraft.ts` keepSwap); an edit to a case already there always lands.
        if (data !== undefined && data !== null && cut > 0 && args.data?.removed !== true) {
          const area = key.slice(0, cut);
          const id = key.slice(cut + 1);
          const out = typeof args.swap_out === "string" ? args.swap_out : null;
          const room = await caseRoom(plane, area, id, out);
          if (room.error) return room.error;
          if (room.room.full && !room.room.exists) {
            if (!out) return toolError(`${area} already keeps ${room.room.cap} cases, the most a step keeps: trade one out with swap_out: "<case id>" (steps or bench lists them).`);
            if (!room.room.out) return toolError(`There is no case "${out}" in ${area} to trade out.`);
            const outKey = area + "/" + out;
            const gone = room.edits[outKey]?.isNew ? null : JSON.stringify({ ...room.room.out, ...(room.edits[outKey] || {}), area, id: out, removed: true });
            const dropped = await plane("case", { key: outKey, data: gone });
            if (dropped.error) return dropped.error;
            const kept = await plane("case", { key, data: JSON.stringify({ ...args.data, area, id, isNew: true, replaces: out }) });
            return kept.error ?? json({ kept: key, tradedOut: outKey, for: "every staff member, as the Lab's case edits" });
          }
        }
        const { error } = await plane("case", { key: args.key, data });
        return error ?? json({ kept: args.key, for: "every staff member, as the Lab's case edits" });
      }
      case "node_stats": {
        const p = await page();
        if (p.error) return p.error;
        try {
          const answer = await nodeStatsAnswer(env, p.page, args, ledgerOf ? { ledgerOf, now: now() } : { now: now() });
          return answer.error ? toolError(answer.error) : json(answer);
        } catch {
          return toolError("Your chats' history could not be read just now.");
        }
      }
      case "chats": {
        const p = await page();
        return p.error ?? json({ chats: chatsOf(p.page) });
      }
      case "turns":
      case "turn":
      case "entries":
      case "moments":
      case "prompt":
      case "jobs":
      case "mine": {
        const p = await page();
        if (p.error) return p.error;
        try {
          // Replay's actions (`replay.js`) work it out with the Lab's own code; `turns` and `entries` read the file as it is.
          const deps = { ledgerOf, origin, fetch: get, session };
          const answer =
            action === "turns" ? await turnsOf(env, p.page, args, ledgerOf ? { ledgerOf } : {})
            : action === "entries" ? await entriesOf(env, p.page, args)
            : action === "turn" ? await turnAnswer(env, p.page, args, deps)
            : action === "moments" ? await momentsAnswer(env, p.page, args, deps)
            : action === "prompt" ? await promptAnswer(env, p.page, args, deps)
            : action === "jobs" ? await jobsAnswer(env, p.page, args, deps)
            : await mineAnswer(env, p.page, args, deps);
          return answer.error ? toolError(answer.error) : json(answer);
        } catch (error) {
          return toolError(error?.status === 404 ? "There is no such chat; chats lists yours." : "That chat's history could not be read just now.");
        }
      }
      // What the Lab computes and shows in the browser, with its own functions (`lab.js`).
      case "sim":
      case "compare":
      case "config":
      case "bench":
      case "modules":
      case "reference":
      case "steps":
      case "marks":
        return labAction(action, args, plane);
      case "sandbox": {
        // The Lab's test chats (`labSandbox/route.js`), the same route the Lab calls, on this connection's own grant,
        // shaped for an AI (`sandbox.js`): run cards, waits, a step whole, re-runs and drafts side by side.
        const answer = await sandbox(args ?? {});
        return answer?.error ? toolError(answer.error) : answer?.tool ? answer.tool : json(answer);
      }
      // The canvas's Put back on a changed step (`engine/changeMarks.ts`), landed as an edit with its conflict check.
      case "put_back": {
        const p = await putBackOps(plane, args);
        if (p.error) return p.error;
        if (p.ops.length === 0) return json({ unchanged: `${args.step} is already as it is in ${p.vs}` });
        return call("edit", { draft: p.draft, rev: p.rev, ops: p.ops });
      }
      default:
        return toolError(`tex_dev has no action "${action}". Its actions: ${ACTIONS.map(([name]) => name).join(", ")}.`);
    }
  };
}

/** The dispatch case: the connection's `texDev` (`http/routing.js`), or the refusal for anyone it was not given to. */
export function toolTexDev(store, args) {
  if (typeof store?.texDev !== "function") return toolError(TEX_DEV_WHO);
  return store.texDev(args?.action, args?.args ?? {});
}
