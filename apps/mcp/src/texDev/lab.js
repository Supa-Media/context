/**
 * `tex_dev` actions `sim`, `compare`, `config`, `bench`, `modules` and `reference`: what the Tex Architecture Lab
 * computes and shows from its own data in the browser, answered with the Lab's own functions (Dev2, 2026-11-15:
 * "anything that can be done inside of the lab should be able to be done inside of the MCP").
 *
 * `lab.generated.js` is the Lab's `engine/forMcp.ts` and everything it reads (its simulation, diff, run config, the
 * bench cases, the modules, its catalogues), bundled to plain JavaScript by `scripts/tex-dev-lab.mjs`; CI fails when
 * it is stale. This file only fetches what the Lab would have loaded (the draft, the shared case edits, the other
 * versions) from the control plane, hands it over, and keeps the answer compact.
 */
import { toolError } from "../tools/results.js";
import { labBench, labChanges, labCompare, labConfig, labModules, labReference, labSim, labSimFor, labTests, labWorkspace } from "./lab.generated.js";

const DRAFT = /^v[0-9a-z]{1,16}$/;
/** How many tests `sim` lists when none is named. */
export const TESTS_SHOWN = 20;

const json = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });
const read = (text, fallback) => {
  try {
    return typeof text === "string" ? JSON.parse(text) : (text ?? fallback);
  } catch {
    return fallback;
  }
};
const str = (v) => (typeof v === "string" && v.trim() ? v : null);

/** A draft as the Lab loads one, from `get`'s answer. */
export function draftFrom(id, answer) {
  return { id, name: answer.name ?? id, by: answer.by, graph: read(answer.graph, null), picks: read(answer.picks, {}), areas: read(answer.areas, null), results: read(answer.results, []) };
}

/** `draft` as a version: "main" (or none) is Tex's config as it runs; else the control plane's draft. */
async function versionOf(plane, id, { mainResults = false } = {}) {
  if (id === undefined || id === null || id === "main") {
    if (!mainResults) return { version: { id: "main", name: "main" } };
    const { answer, error } = await plane("versions", { drafts: [] });
    if (error) return { error };
    return { version: { id: "main", name: "main", results: read(answer.main?.results, []) } };
  }
  if (typeof id !== "string" || !DRAFT.test(id)) return { error: toolError('Name the version: { draft: "v…" } or "main" (list shows the drafts).') };
  const { answer, error } = await plane("get", { draft: id });
  if (error) return { error };
  const version = draftFrom(id, answer);
  return version.graph ? { version } : { error: toolError("This draft's graph could not be read.") };
}

/** The Lab's shared case edits and new cases, keyed `<area>/<id>` as `store.ts` keeps them. */
async function caseEditsOf(plane) {
  const { answer, error } = await plane("cases");
  if (error) return { error };
  const edits = {};
  for (const row of answer.caseEdits ?? []) {
    const c = read(row.data, null);
    if (c && typeof c.area === "string" && typeof c.id === "string") edits[c.area + "/" + c.id] = c;
  }
  return { edits };
}

const test = (args) => ({ test: str(args.test), text: str(args.text), from: str(args.from) });

/** The Lab's work, or its plain sentence when the input names nothing it has. */
function run(fn) {
  try {
    return { value: fn() };
  } catch (error) {
    return { error: toolError(error instanceof Error && error.message ? error.message : "The Lab could not work that out.") };
  }
}

async function labIn(plane, args, { cases = true, mainResults = false } = {}) {
  const v = await versionOf(plane, args.draft, { mainResults });
  if (v.error) return v;
  const c = cases ? await caseEditsOf(plane) : { edits: {} };
  if (c.error) return c;
  return { input: { draft: v.version, caseEdits: c.edits } };
}

/** One of this file's actions, for the connection's control plane (`plane(action, args)` answers `{ answer } | { error }`). */
export async function labAction(action, args, plane) {
  switch (action) {
    case "sim": {
      const got = await labIn(plane, args);
      if (got.error) return got.error;
      let base = null;
      if (args.base !== undefined && args.base !== "main") {
        const b = await versionOf(plane, args.base);
        if (b.error) return b.error;
        base = b.version;
      }
      const log = typeof args.log === "string" ? args.log.slice(0, 500_000) : null;
      const r = run(() => labSim(got.input, { ...test(args), base, log }));
      if (r.error) return r.error;
      if (args.test || args.text) return json(r.value);
      const all = run(() => labTests(got.input)).value ?? [];
      return json({ ...r.value, tests: all.slice(0, TESTS_SHOWN), testsTotal: all.length, pick: "sim { test: <key> } traces one; { text } traces a message you type, as the canvas does" });
    }
    case "compare": {
      const want = Array.isArray(args.drafts) ? args.drafts.filter((d) => typeof d === "string" && DRAFT.test(d)).slice(0, 20) : undefined;
      const { answer, error } = await plane("versions", want ? { drafts: want } : {});
      if (error) return error;
      const c = await caseEditsOf(plane);
      if (c.error) return c.error;
      const others = [{ id: "main", name: "main", results: read(answer.main?.results, []) }, ...(answer.drafts ?? []).map((d) => draftFrom(d.id, d))];
      const r = run(() => labCompare({ draft: others[0], caseEdits: c.edits, others }, test(args)));
      return r.error ?? json({ ...r.value, ...(answer.more ? { more: answer.more } : {}) });
    }
    case "config": {
      const got = await labIn(plane, args, { mainResults: true });
      if (got.error) return got.error;
      const r = run(() => labConfig(got.input));
      if (r.error) return r.error;
      const { prompt, configJson, ...summary } = r.value;
      const next = "The second block is the Lab's \"Copy config JSON\": save it, unchanged, as lab.json at the repo root and run `pnpm ai lab plan --config lab.json`, `apply`, then `run` (apps/mcp/bench/lab.mjs; docs/testing/examiner.md). { prompt: true } adds the Lab's whole prompt for a Claude Code session.";
      const content = [{ type: "text", text: JSON.stringify({ ...summary, next }, null, 1) }, { type: "text", text: configJson }];
      if (args.prompt === true) content.push({ type: "text", text: prompt });
      return { content };
    }
    case "bench": {
      if (str(args.ws)) {
        const r = run(() => labWorkspace(args.ws, str(args.at)));
        return r.error ?? json(r.value);
      }
      const got = await labIn(plane, args);
      if (got.error) return got.error;
      const limit = Number.isSafeInteger(args.limit) ? args.limit : undefined;
      const offset = Number.isSafeInteger(args.offset) ? args.offset : undefined;
      const r = run(() => labBench(got.input, { area: str(args.area), query: str(args.query), limit, offset, full: args.full === true }));
      return r.error ?? json(r.value);
    }
    case "modules": {
      const got = await labIn(plane, args, { cases: false });
      if (got.error) return got.error;
      const r = run(() => labModules(got.input, { key: str(args.key), full: args.full === true }));
      return r.error ?? json(r.value);
    }
    case "reference": {
      const got = await labIn(plane, args, { cases: false });
      if (got.error) return got.error;
      const r = run(() => labReference(got.input, str(args.topic), typeof args.log === "string" ? args.log.slice(0, 500_000) : null));
      return r.error ?? json(r.value);
    }
    default:
      return toolError(`tex_dev has no action "${action}".`);
  }
}

/** How a draft's modules and conversation view differ from main, the Lab's nav tags (for `get`'s `vsMain`). */
export function labWording(id, answer) {
  const r = run(() => labChanges({ draft: draftFrom(id, answer) }));
  return r.value ?? {};
}

/**
 * For `snapshot` with a test: the Lab's simulation of the graph as drawn, so each step carries its time and the stats
 * chip shows, as on the canvas. Null when no test is asked for.
 */
export async function snapshotSim(plane, args, draftAnswer) {
  const t = test(args);
  if (!t.test && !t.text) return { sim: null };
  const c = await caseEditsOf(plane);
  if (c.error) return c;
  const draft = draftAnswer ? draftFrom(args.draft, draftAnswer) : args.graph !== undefined ? { id: "vgraph", name: "graph", graph: read(args.graph, null) } : { id: "main", name: "main" };
  return { sim: labSimFor({ draft, caseEdits: c.edits }, t) };
}
