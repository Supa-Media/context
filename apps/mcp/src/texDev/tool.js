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
import { TEX_CONFIG } from "../agent/texConfig.js";
import { toolError } from "../tools/results.js";
import { draftProblems, draftVsMain } from "./check.js";
import { guideText } from "./guide.js";
import { chatsOf, entriesOf, turnsOf } from "./probe.js";
import { jobsAnswer, linkAnswer, mineAnswer, momentsAnswer, promptAnswer, turnAnswer } from "./replay.js";
import { snapshotGraph } from "./snapshot.js";
import { createDraftWrites } from "./writes.js";

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
export function createTexDev({ env, session, controlPlane, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, fetch: get = (...a) => globalThis.fetch(...a), ledgerOf = undefined }) {
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
    return { page: answer };
  }

  // The Lab's other writes (rename, delete, run_setup, keep_results, revert) and `get` of main (`writes.js`).
  const writes = createDraftWrites({ plane, json, linkOf });

  const needDraft = (args) => (typeof args?.draft === "string" && DRAFT.test(args.draft) ? null : toolError("Name the draft: { draft: \"v…\" } (list shows them)."));

  return async function call(action, args = {}) {
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
        const body = args.graph !== undefined ? { name: args.name, graph: JSON.stringify(graph) } : from === "main" ? { name: args.name, from, graph: JSON.stringify(graph) } : { name: args.name, from };
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
        return json({ ...about, link: linkOf(args.draft), vsMain: draftVsMain(graph), problems: draftProblems(graph), picks: read(picks, {}), areas: read(areas, null), results: read(results, []), graph });
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
        if (args.graph !== undefined) graph = parseGraph(args.graph);
        else if (typeof args.draft === "string") {
          const got = await draftGraph(args.draft);
          if (got.error) return got.error;
          graph = got.graph;
        } else graph = mainGraph();
        if (graph === null) return toolError("snapshot takes a draft, or graph as { nodes: [...], edges: [...] }.");
        const shot = await snapshotGraph(env, graph, { focus: args.focus ?? null, base: mainGraph(), theme: args.theme === "light" ? "light" : "dark" });
        if (!shot.ok) return toolError(shot.error);
        return { content: [{ type: "image", data: shot.png, mimeType: "image/png" }, { type: "text", text: args.draft ? `Draft ${args.draft} · live at ${linkOf(args.draft)}` : "Main as it runs today." }] };
      }
      case "link": {
        // A place in the Lab or in Replay (`replay.js` `linkAnswer`): a page, or a chat and a moment, as the Lab's address holds it.
        const place = args.mode !== undefined || args.page !== undefined || args.chat !== undefined || args.moment !== undefined;
        if (!place || args.draft !== undefined) {
          if (needDraft(args)) return place ? needDraft(args) : toolError("link takes a draft, or a place: { mode: \"replay\", chat?, moment? } or { page }.");
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
        return error ?? json({ promote: "asked", then: "Its pull request opens within 15 minutes and merges only through CI and the replay gate; list shows it." });
      }
      case "tool_stats": {
        const { answer, error } = await plane("tool_stats", { days: args.days });
        return error ?? json(answer.stats);
      }
      case "cases": {
        const { answer, error } = await plane("cases");
        return error ?? json({ caseEdits: answer.caseEdits, note: "The bench's own cases are in apps/mcp/bench/cases/; these are the Lab's shared edits and new cases over them." });
      }
      case "case": {
        const data = args.data === null ? null : args.data !== undefined ? JSON.stringify(args.data) : undefined;
        const { error } = await plane("case", { key: args.key, data });
        return error ?? json({ kept: args.key, for: "every staff member, as the Lab's case edits" });
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
      default:
        return toolError(`tex_dev has no action "${action}". Its actions: guide, list, create, get, edit, changes, snapshot, link, check, promote, tool_stats, cases, case, chats, turns, turn, entries, moments, prompt, jobs, mine, rename, delete, run_setup, keep_results, revert.`);
    }
  };
}

/** The dispatch case: the connection's `texDev` (`http/routing.js`), or the refusal for anyone it was not given to. */
export function toolTexDev(store, args) {
  if (typeof store?.texDev !== "function") return toolError(TEX_DEV_WHO);
  return store.texDev(args?.action, args?.args ?? {});
}
