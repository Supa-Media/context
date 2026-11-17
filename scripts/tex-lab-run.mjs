#!/usr/bin/env node
/**
 * A LAB RUN ON GITHUB (Dev2, 2026-11-16: "Ok go ahead and build everything"; `apps/convex/functions/texLabRuns.ts`).
 * The two halves of `.github/workflows/tex-lab-run.yml` around the bench's node-alone runner
 * (`node apps/mcp/bench/run.mjs sets run`):
 *
 *   node scripts/tex-lab-run.mjs prepare <job.json> <dir>     the conversations to run, and the draft's graph
 *   node scripts/tex-lab-run.mjs results <rows.json> <ms>     the results the run reports back, as JSON
 *
 * `prepare` reads the run Convex hands the workflow (`texLabRuns:job`): the Dev set is the repo's
 * (`apps/mcp/bench/sets/dev`) with the Lab's drafts over it (a draft in Dev replaces or adds a conversation; one moved
 * to Training or removed leaves it out). Never Training, and never the Test set, which is not in the repo or in the
 * Lab's drafts at all. It writes `<dir>/convs.json`, and `<dir>/graph.json` when the run is a draft's. Standard output
 * says counts and ids only: the workflow's log is public.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSets } from "../apps/mcp/bench/sets.mjs";

/** The Dev conversations a run covers: the repo's with the Lab's drafts over them, one chat when the run names one. */
export function devConversations(repo, drafts, convId = null) {
  const byId = new Map(repo.filter((c) => c.set === "dev").map((c) => [c.id, c]));
  for (const d of drafts ?? []) {
    if (d.set !== "dev" || d.removed) {
      byId.delete(d.id);
      continue;
    }
    let conv = null;
    try {
      conv = typeof d.conv === "string" ? JSON.parse(d.conv) : d.conv;
    } catch {
      conv = null;
    }
    if (conv && Array.isArray(conv.msgs)) byId.set(d.id, { ...conv, id: d.id, set: "dev" });
  }
  const all = [...byId.values()];
  if (convId === null) return all;
  return all.filter((c) => c.id === convId);
}

/** The runner's rows as the Lab reads a run's results (`texLabRuns.cleanResults`). */
export function resultsOf(rows, ms) {
  const perConv = new Map();
  const perNode = new Map();
  const add = (map, key, field, ok) => {
    const b = map.get(key) ?? { [field]: key, pass: 0, total: 0 };
    b.total += 1;
    if (ok) b.pass += 1;
    map.set(key, b);
  };
  for (const r of rows) {
    add(perConv, r.chat, "id", r.right);
    add(perNode, r.node, "node", r.right);
  }
  return {
    pass: rows.filter((r) => r.right).length,
    total: rows.length,
    costUsd: Math.round(rows.reduce((a, r) => a + (r.usd || 0), 0) * 10_000) / 10_000,
    ms: Number(ms) || 0,
    perConv: [...perConv.values()],
    perNode: [...perNode.values()],
    rows: rows.map((r) => ({
      convId: r.chat,
      msgIndex: r.at ?? 0,
      node: r.node,
      ok: Boolean(r.right),
      // A test that did not run says why (Dev2, 2026-11-16: twenty Front door tests read only "can't run alone").
      got: r.ran === false ? `can't run: ${String(r.why ?? "no way to run alone yet").slice(0, 200)}` : String(r.got ?? (r.right ? "as labelled" : r.why ?? "")),
      want: String(r.want ?? ""),
      ...(r.ran === false ? { ran: false } : {}),
      // A miss's whole story: each failed line with the judge's reason, then every text Tex sent, so a reader can find
      // the cause without rerunning (Dev set, 2026-11-17: misses showed one cut line and nothing of the judge's reason).
      ...(r.right ? {} : detailOf(r)),
    })),
  };
}

/** A missed row's detail: "never: <line> (<judge's reason>)" per failed line, then "Tex: <texts>"; empty when there is none. */
export function detailOf(r) {
  const misses = (Array.isArray(r.misses) ? r.misses : []).map((m) => `${m.kind === "must not" ? "never" : "must"}: ${m.line}${m.reason ? ` (${m.reason})` : ""}`);
  const said = Array.isArray(r.said) ? r.said.filter((t) => typeof t === "string") : [];
  const text = [...misses, ...(said.length > 0 ? [`Tex: ${said.join(" / ")}`] : [])].join("\n").slice(0, DETAIL_CHARS);
  return text === "" ? {} : { detail: text };
}

/** At most this much of a row's detail is kept (`apps/convex/functions/texLabRuns.ts` keeps the same). */
const DETAIL_CHARS = 1_500;

async function main() {
  const [sub, a, b] = process.argv.slice(2);
  if (sub === "prepare") {
    const job = JSON.parse(readFileSync(a, "utf8"));
    if (!job || typeof job !== "object") throw new Error("no such run");
    mkdirSync(b, { recursive: true });
    const convs = devConversations(await loadSets(), job.drafts, job.kind === "chat" ? job.convId : null);
    if (job.kind === "chat" && convs.length === 0) throw new Error(`${job.convId} is not a Dev conversation`);
    writeFileSync(join(b, "convs.json"), JSON.stringify(convs));
    if (job.graph) writeFileSync(join(b, "graph.json"), job.graph);
    console.log(`Dev conversations: ${convs.length} (${convs.map((c) => c.id).join(", ")}); ${job.graph ? "draft graph" : "main"}`);
    return;
  }
  if (sub === "results") {
    process.stdout.write(JSON.stringify(resultsOf(JSON.parse(readFileSync(a, "utf8")), b)));
    return;
  }
  throw new Error("usage: tex-lab-run.mjs prepare <job.json> <dir> | results <rows.json> <ms>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`tex-lab-run: ${error.message}`);
    process.exit(1);
  });
}
