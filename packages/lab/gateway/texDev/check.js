/**
 * `tex_dev` action `check`: what a draft would meet on its way to being Tex's config, without promoting it.
 *
 * Two sets of checks, both the ones the real path runs: the runner's own (`texGraph.cjs` `problemsOf`: unique ids,
 * wires that join real steps with a real mode, no cycle over wait and background wires), and Promote's
 * (`scripts/tex-lab-promote.mjs` `configFrom`: a new step needs code first, a step is turned off rather than deleted,
 * every model has a gateway id, efforts and on/off are real values, and a provisional wire keeps `firstLook` and
 * `sms`). The pull request Promote opens runs CI and the replay gate on top; those are named, not run, here.
 */

import { problemsOf } from "../../../tex/src/texGraph.cjs";
import { CONFIG_STAMP, TEX_CONFIG } from "../fromGateway/agent_texConfig.js";
import SHELF from "../../../tex/src/texNodeShelf.json" with { type: "json" };
import { EFFORTS as SCHEMA_EFFORTS, provisionalHoldProblems } from "../../../tex/src/texConfigSchema.cjs";

const EFFORTS = new Set(SCHEMA_EFFORTS);

/**
 * Why a step's model would not promote. A draft may keep models of its own (`graph.models`, the Lab's model form and
 * the `model` edit), which the Lab runs and prices like any other; Promote writes only models Tex's config already
 * has, so a step on one is named as the draft's own model, with the config's key when its id is one Tex has.
 */
function modelProblem(n, own, models) {
  const known = `${Object.keys(models).join(", ")}, or code`;
  const mine = own && typeof own === "object" ? own[n.model] : undefined;
  if (!mine) return `promote: step "${n.id}" runs on "${n.model}", which is neither one of this draft's own models nor in Tex's config (${known})`;
  const same = Object.entries(models).find(([, id]) => id === mine.id)?.[0];
  return same
    ? `promote: step "${n.id}" runs on this draft's own model "${n.model}", whose id ${mine.id} is Tex's "${same}": set the step's model to "${same}" to promote`
    : `promote: step "${n.id}" runs on this draft's own model "${n.model}"${typeof mine.id === "string" ? ` (${mine.id})` : ""}, which Tex's config has no gateway model for yet; add it to texConfig.json's models in a pull request first (${known})`;
}

/**
 * Every problem the draft's graph has, as plain lines; [] when it would promote. `base` is the stamp of the main the
 * draft was made from (`texConfigStamp.cjs`; null for a draft saved before drafts kept one, undefined for a graph with
 * no draft). Promote merges only what a draft changed since its base (`scripts/tex-lab-merge.mjs`), so a step main
 * added after that is not one the draft deleted: it is only named "gone" for a draft made from main as it is now.
 */
export function draftProblems(graph, current = TEX_CONFIG, shelf = Object.keys(SHELF.nodes ?? {}), base = undefined) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return ["the draft has no steps and wires"];
  const problems = problemsOf({ nodes: graph.nodes, edges: graph.edges }).map((p) => `runner: ${p}`);
  // The same hold check CI and Promote run (`provisionalHoldProblems`), so a saved draft that drops one is refused here too.
  problems.push(...provisionalHoldProblems(graph.edges));
  const known = new Set(current.nodes.map((n) => n.id));
  const shelved = new Set(shelf);
  const ids = new Set(graph.nodes.map((n) => n?.id));
  for (const n of graph.nodes) {
    if (!known.has(n.id) && !shelved.has(n.id)) problems.push(`promote: step "${n.id}" is new; the gateway has no code for it yet, so merge its code to main first, on the shelf (apps/mcp/src/agent/graph/nodes/ and packages/tex/src/texNodeShelf.json)`);
    if (typeof n.model !== "string" || (n.model !== "code" && typeof current.models[n.model] !== "string")) problems.push(modelProblem(n, graph.models, current.models));
    if (n.effort !== undefined && !EFFORTS.has(n.effort)) problems.push(`promote: step "${n.id}" has effort "${n.effort}" (${[...EFFORTS].join(", ")})`);
    if (typeof n.on !== "boolean") problems.push(`promote: step "${n.id}" is neither on nor off`);
  }
  const fromNow = base === undefined || (current === TEX_CONFIG && base === CONFIG_STAMP);
  if (fromNow) for (const id of known) if (!ids.has(id)) problems.push(`promote: step "${id}" is gone; the gateway still runs it, so turn it off instead of deleting it`);
  return problems;
}

/** The fields each step differs in from main, `{ changed: {id: [fields]}, added: [ids], removed: [ids], wires: {added, removed} }`. */
export function draftVsMain(graph, current = TEX_CONFIG) {
  const main = new Map(current.nodes.map((n) => [n.id, n]));
  const changed = {};
  const added = [];
  for (const n of graph.nodes) {
    const m = main.get(n.id);
    if (!m) {
      added.push(n.id);
      continue;
    }
    const fields = [...new Set([...Object.keys(m), ...Object.keys(n)])].filter((k) => k !== "x" && k !== "y" && JSON.stringify(m[k]) !== JSON.stringify(n[k]));
    if (fields.length) changed[n.id] = fields;
  }
  const ids = new Set(graph.nodes.map((n) => n.id));
  const removed = current.nodes.map((n) => n.id).filter((id) => !ids.has(id));
  const key = (e) => `${e.from} → ${e.to} (${e.mode}, when ${(e.when ?? ["*"]).join(",")})`;
  const before = new Set(current.edges.map(key));
  const after = new Set(graph.edges.map(key));
  return { changed, added, removed, wires: { added: [...after].filter((k) => !before.has(k)), removed: [...before].filter((k) => !after.has(k)) } };
}
