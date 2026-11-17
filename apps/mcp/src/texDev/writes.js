/**
 * `tex_dev`'s actions for everything else the Lab writes to a draft (Dev2, 2026-11-15: "anything that can be done
 * inside of the lab should be able to be done inside of the MCP"): its name (`rename`), deleting it (`delete`), the
 * Run tab's test picks and areas (`run_setup`), a run's kept results (`keep_results`, on a draft or on main, and `get`
 * of main to read main's), and undoing a change (`revert`). The control plane does each write and decides again who
 * may (`functions/lib/texLabDraftWrites.ts`); here is only what the answer says.
 */

import { toolError } from "../tools/results.js";
import { draftProblems } from "./check.js";

const DRAFT = /^v[0-9a-z]{1,16}$/;
/** `get` of main answers at most this many of its kept results, newest last, unless `limit` asks for more. */
export const MAIN_RESULTS = 20;

const readJson = (text, fallback) => {
  try {
    return typeof text === "string" ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/** A kept result without its pasted text, unless asked: the scores, headline, link and when. */
const brief = (r) => {
  const { raw: _raw, ...rest } = r ?? {};
  return rest;
};

/**
 * The writes for one connection. `plane(action, args)` is the tool's own call to the control plane (answering
 * `{ answer }` or `{ error }`), `json` its answer shape, `linkOf` a draft's Lab address. Answers null for an action
 * that is not one of these, so the tool's own switch takes it.
 */
export function createDraftWrites({ plane, json, linkOf }) {
  const needDraft = (args) => (typeof args?.draft === "string" && DRAFT.test(args.draft) ? null : toolError('Name the draft: { draft: "v…" } (list shows them; main is Tex as it runs and is changed only through a draft).'));
  const graphOf = async (draft) => {
    const { answer } = await plane("get", { draft });
    const graph = readJson(answer?.graph, null);
    return graph && Array.isArray(graph.nodes) ? { graph, base: answer.base ?? null } : null;
  };

  return async function write(action, args = {}) {
    switch (action) {
      case "get": {
        if (args?.draft !== "main") return null;
        const { answer, error } = await plane("get", { draft: "main" });
        if (error) return error;
        const all = readJson(answer.results, []);
        const limit = Math.max(1, Math.min(200, Number(args.limit) || MAIN_RESULTS));
        const shown = all.slice(-limit);
        return json({
          draft: "main",
          name: "main",
          results: args.full === true ? shown : shown.map(brief),
          resultsKept: all.length,
          ...(all.length > shown.length ? { older: `${all.length - shown.length} older; limit (up to 200) shows more` } : {}),
          note: "Main is Tex as it runs today: its steps are in guide and snapshot, and create copies it into a draft. Main keeps only its run results.",
        });
      }
      case "rename": {
        if (needDraft(args)) return needDraft(args);
        const { answer, error } = await plane("rename", { draft: args.draft, name: args.name });
        return error ?? json({ rev: answer.rev, name: answer.name, kept: answer.said, link: linkOf(args.draft) });
      }
      case "delete": {
        if (needDraft(args)) return needDraft(args);
        // The Lab asks twice ("Delete?" then "Yes, delete"); so does this.
        if (args.confirm !== true) return toolError(`Deleting ${args.draft} is permanent: its graph, its kept results and its change list go, for everyone. Send it again with confirm: true to delete.`);
        const { answer, error } = await plane("delete", { draft: args.draft });
        return error ?? json({ deleted: answer.deleted, name: answer.name, note: "Gone for everyone, with its change list; it cannot be brought back." });
      }
      case "run_setup": {
        if (needDraft(args)) return needDraft(args);
        const { answer, error } = await plane("run_setup", { draft: args.draft, picks: args.picks, areas: args.areas });
        return (
          error ??
          json({
            rev: answer.rev,
            picks: answer.picks,
            areas: answer.areas,
            kept: answer.said,
            means: "picks: the cases ticked per area (an area not listed runs every case); areas: the areas the run covers (null: the ones the draft's changes touch). The Lab's Run tab shows the same.",
          })
        );
      }
      case "keep_results": {
        if (args?.draft !== "main" && needDraft(args)) return needDraft(args);
        if (typeof args.report !== "string" || !args.report.trim()) return toolError('keep_results takes report: the run\'s "## Lab run" block as it printed (pnpm ai lab run), and link if it has one.');
        const { answer, error } = await plane("keep_results", { draft: args.draft, report: args.report, link: args.link });
        if (error) return error;
        return json({
          ...(answer.rev !== undefined ? { rev: answer.rev } : {}),
          kept: answer.kept,
          results: answer.results,
          ...(answer.noted ? { noted: answer.noted } : {}),
          ...(args.report.includes("## Lab replay") ? { replay: "Its \"## Lab replay\" part was not kept: it is the person's own chat, and every staff member reads a version." } : {}),
        });
      }
      case "revert": {
        if (needDraft(args)) return needDraft(args);
        const { answer, error } = await plane("revert", { draft: args.draft, rev: args.rev, to: args.to });
        if (error) return error;
        if (answer.status === "conflict") return json({ refused: "a later change touched the same thing; nothing was undone", pieces: answer.keys, later: answer.later, rev: answer.rev, next: answer.next });
        const got = answer.said?.length ? await graphOf(args.draft) : null;
        return json({ rev: answer.rev, kept: answer.said, ...(answer.note ? { note: answer.note } : {}), problems: got ? draftProblems(got.graph, undefined, undefined, got.base) : null, link: linkOf(args.draft) });
      }
      default:
        return null;
    }
  };
}
