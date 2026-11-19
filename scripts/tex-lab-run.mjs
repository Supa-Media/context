#!/usr/bin/env node
/**
 * A LAB RUN ON GITHUB (Dev2, 2026-11-16: "Ok go ahead and build everything"; `apps/convex/functions/texLabRuns.ts`).
 * The two halves of `.github/workflows/tex-lab-run.yml` around the bench's node-alone runner
 * (`node apps/mcp/bench/run.mjs sets run`):
 *
 *   node scripts/tex-lab-run.mjs prepare <job.json> <dir>     the conversations to run, and the draft's graph
 *   node scripts/tex-lab-run.mjs results <rows.json> <ms> [gold.json]
 *                                                             the results the run reports back, as JSON; with the gold
 *                                                             report (`setsGold.mjs`), its ambiguous rows are out of the score
 *   node scripts/tex-lab-run.mjs ran <rows.json>              fails when a step had tests and none of them could run
 *
 * `prepare` reads the run Convex hands the workflow (`texLabRuns:job`): the Dev set is the repo's
 * (`apps/mcp/bench/sets/dev`) with the Lab's drafts over it (a draft in Dev replaces or adds a conversation; one moved
 * to Training or removed leaves it out). A run with `set: "training"` runs the repo's Training set instead
 * (`trainingConversations`). Never the Test set, which is not in the repo or in the Lab's drafts at all. It writes `<dir>/convs.json`, and `<dir>/graph.json` when the run is a draft's. Standard output
 * says counts and ids only: the workflow's log is public.
 *
 * A run that could not run its tests FAILS, it never reads as a score (Lab run 2026-11-17: Training's Front door came
 * back 0/63 in thirty seconds, every row "has no bench world", and looked like a result). `prepare` refuses a
 * conversation whose people the bench has no world or shared workspace for when the Front door's tests are to run
 * (`castProblems`), and `ran` refuses rows where a whole step did not run. Each says why to the file `TEX_LAB_WHY`
 * names, which the workflow reports to the Lab as the run's error; standard error keeps to ids and counts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fallbackVerdict } from "../apps/mcp/bench/fallbacks.mjs";
import { parsePeople } from "../apps/mcp/bench/load.mjs";
import { loadSets } from "../apps/mcp/bench/sets.mjs";
import { castProblems } from "../apps/mcp/bench/setsFd.mjs";

const { unitTests } = createRequire(import.meta.url)("../packages/shared/src/texSets.cjs");
const PEOPLE = fileURLToPath(new URL("../apps/mcp/bench/ai/workspaces/people.md", import.meta.url));

/** An error whose `why` is for the Lab (the run's error, kept in Convex) and whose message is for the public log. */
class Refused extends Error {
  constructor(message, why) {
    super(message);
    this.why = why;
  }
}

/** Whether a conversation's own world (`apps/mcp/bench/setsWorld.mjs`) brings a shared workspace: a folder there that is nobody's personal one. */
function ownShared(c, people) {
  const dir = new URL(`../apps/mcp/bench/sets/worlds/${c.id}/workspaces/`, import.meta.url);
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(c.id)) || !existsSync(dir)) return false;
  const personal = new Set(people.filter((row) => row.personal).map((row) => row.workspace));
  return readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() && !personal.has(entry.name));
}

/**
 * The conversations of a run whose Front door tests could not run in the bench, each with why: `[{ id, problems }]`.
 * Only those with a Front door test, and only when the run covers the Front door (`node` null or "fd").
 */
export function uncast(convs, people, node = null) {
  if (node && node !== "fd") return [];
  return convs
    .filter((c) => unitTests(c).some((t) => t.node === "fd"))
    .map((c) => ({ id: c.id, problems: castProblems(c, people, { ownWorkspace: ownShared(c, people) }) }))
    .filter((x) => x.problems.length > 0);
}

/**
 * The steps of a run's rows that had tests and ran none of them: `[{ node, total, why }]`, `why` the first row's. A
 * test that can't run alone is its row's to say (`ran: false`); a whole step that did not run is a broken run.
 */
export function unrun(rows) {
  const by = new Map();
  for (const r of rows) {
    const b = by.get(r.node) ?? { node: r.node, total: 0, ran: 0, why: "" };
    b.total += 1;
    if (r.ran !== false) b.ran += 1;
    else if (b.why === "") b.why = String(r.why ?? "no way to run alone yet").slice(0, 160);
    by.set(r.node, b);
  }
  return [...by.values()].filter((b) => b.ran === 0).map(({ node, total, why }) => ({ node, total, why }));
}

/**
 * Why a run's score is not a score: some Claude call ran out of credit, or more than half of one step's tests could not
 * run. `null` when neither (gw Lab runs, 2026-11-18: every Claude call failed for lack of credit, and 69 of 101 rows
 * were stored as valid). A step that ran none of its tests is `unrun`'s to refuse first.
 */
export function brokenRun(rows) {
  const credit = rows.find((r) => r.ran === false && /credit/i.test(String(r.why ?? "")));
  if (credit) return `Claude calls could not run: ${String(credit.why).slice(0, 240)}`;
  const by = new Map();
  for (const r of rows) {
    const b = by.get(r.node) ?? { node: r.node, total: 0, out: 0, why: "" };
    b.total += 1;
    if (r.ran === false) {
      b.out += 1;
      if (b.why === "") b.why = String(r.why ?? "no way to run alone yet").slice(0, 160);
    }
    by.set(r.node, b);
  }
  const most = [...by.values()].find((b) => b.out * 2 > b.total);
  return most ? `${most.out} of ${most.node}'s ${most.total} tests could not run: ${most.why}` : null;
}

/** A run's verdict: the fallback count, and whether its score is Tex's (`fallbacks.mjs`, `brokenRun`). */
export function runVerdict(rows) {
  const fell = fallbackVerdict(rows);
  const broken = brokenRun(rows);
  if (broken === null) return fell;
  return { fallbacks: fell.fallbacks, valid: false, invalid: (fell.valid ? broken : `${broken}; ${fell.invalid}`).slice(0, 200) };
}

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

/**
 * The Training conversations a Training run covers: the repo's, less any the Lab moved to Dev or removed (Dev2,
 * 2026-11-18: "prove it on Training ... a scored Lab Training run"). The Lab's Training drafts carry only their id and
 * set, so a conversation edited in the Lab runs as the repo has it until its Promote.
 */
export function trainingConversations(repo, drafts, convId = null) {
  const gone = new Set((drafts ?? []).filter((d) => d.set !== "training" || d.removed).map((d) => d.id));
  const all = repo.filter((c) => c.set === "training" && !gone.has(c.id));
  return convId === null ? all : all.filter((c) => c.id === convId);
}

/**
 * The runner's rows as the Lab reads a run's results (`texLabRuns.cleanResults`). A row that could not run (`ran: false`)
 * and, with the gold report (`apps/mcp/bench/setsGold.mjs`), an fd row whose label's own gold reply fails (ambiguous)
 * are out of the score: pass, total, perConv and perNode. Each is listed beside it (couldNotRun, ambiguous).
 */
export function resultsOf(rows, ms, gold = null) {
  const goldKey = (convId, msgIndex) => `${convId}\u0000${msgIndex}`;
  const goldFail = new Map();
  for (const g of Array.isArray(gold?.goldFails) ? gold.goldFails : []) {
    if (!goldFail.has(goldKey(g.convId, g.msgIndex))) goldFail.set(goldKey(g.convId, g.msgIndex), g);
  }
  const ambiguousOf = (r) => r.node === "fd" && r.ran !== false && goldFail.has(goldKey(r.chat, r.at ?? 0));
  const isAmbiguous = new Set(rows.filter(ambiguousOf));
  const counted = rows.filter((r) => r.ran !== false && !isAmbiguous.has(r));

  const perConv = new Map();
  const perNode = new Map();
  const add = (map, key, field, ok) => {
    const b = map.get(key) ?? { [field]: key, pass: 0, total: 0 };
    b.total += 1;
    if (ok) b.pass += 1;
    map.set(key, b);
  };
  for (const r of counted) {
    add(perConv, r.chat, "id", r.right);
    add(perNode, r.node, "node", r.right);
  }
  const couldNotRun = rows
    .filter((r) => r.ran === false)
    .map((r) => ({ convId: r.chat, msgIndex: r.at ?? 0, node: r.node, why: String(r.why ?? "no way to run alone yet").slice(0, 200) }));
  const ambiguous = rows
    .filter((r) => isAmbiguous.has(r))
    .map((r) => {
      const first = goldFail.get(goldKey(r.chat, r.at ?? 0)).failed?.[0];
      const why = `its label's own gold reply fails${first ? `: ${first.kind} ${first.line}${first.reason ? ` (${first.reason})` : ""}` : ""}`;
      return { convId: r.chat, msgIndex: r.at ?? 0, node: r.node, why: why.slice(0, 200) };
    });
  return {
    pass: counted.filter((r) => r.right).length,
    total: counted.length,
    couldNotRun,
    ambiguous,
    goldFails: gold ? (Array.isArray(gold.goldFails) ? gold.goldFails.length : 0) : null,
    costUsd: Math.round(rows.reduce((a, r) => a + (r.usd || 0), 0) * 10_000) / 10_000,
    // What the background jobs the Front door handed off added, already inside costUsd (Dev2, 2026-11-18: "report how
    // many advisor calls and how much cost a handed-off job adds per run ... so Finance can check spend").
    handoff: handoffOf(rows),
    // Claude calls answered by the fallback model, and whether the score is Tex's (`fallbacks.mjs`): one is enough to
    // mark the run invalid, so a fallback model's score cannot pass as Tex's (2026-11-18).
    // And a run whose Claude calls ran out of credit, or most of one step's tests could not run, is not valid either.
    ...runVerdict(rows),
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
      ...(isAmbiguous.has(r) ? { ambiguous: true } : {}),
      ...(Number(r.fallbacks) > 0 ? { fallbacks: Number(r.fallbacks) } : {}),
      // A row's whole story: each failed line with the judge's reason, each line that held with its reason, then every
      // text Tex sent, so a reader can find the cause, or audit a pass, without rerunning (Dev2, 2026-11-17).
      ...detailOf(r),
      // The row's route and cost (Dev2, 2026-11-18: cost per turn and the route summary, `texRouteSummary.cjs`).
      ...routeSpread(r),
      ...(typeof r.usd === "number" && Number.isFinite(r.usd) ? { usd: r.usd } : {}),
    })),
  };
}

/**
 * A row's route, as the Lab keeps it (`cleanResults`): the router node's own `route` when the row ran it alone, else its
 * first texted turn's (`routes`, the bench's Route line, `coreArea.mjs`). Only the words and the sure number that are there.
 */
export function routeOf(r) {
  const firstRun = Array.isArray(r?.routes) ? r.routes.find((run) => Array.isArray(run) && run.length > 0) : null;
  const from = r?.route && typeof r.route === "object" ? r.route : firstRun?.[0] && typeof firstRun[0] === "object" ? firstRun[0] : null;
  if (!from) return null;
  const out = {
    ...(typeof from.pick === "string" && from.pick !== "" ? { pick: from.pick } : {}),
    ...(typeof from.sure === "number" && Number.isFinite(from.sure) ? { sure: from.sure } : {}),
    ...(typeof from.door === "string" && from.door !== "" ? { door: from.door } : {}),
    ...(typeof from.fellBack === "string" && from.fellBack !== "" ? { fellBack: from.fellBack } : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

/** A row's `route` field, when it has one. */
export function routeSpread(r) {
  const route = routeOf(r);
  return route === null ? {} : { route };
}

/** A row's route words for its detail: "route: pick read (sure 0.9), door read", and "fell back: <why>" when a specialist handed over. */
export function routeLine(route) {
  if (!route) return null;
  const parts = [
    ...(route.pick ? [`pick ${route.pick}${route.sure === undefined ? "" : ` (sure ${route.sure})`}`] : []),
    ...(route.door ? [`door ${route.door}`] : []),
    ...(route.fellBack ? [`fell back: ${route.fellBack}`] : []),
  ];
  return parts.length > 0 ? `route: ${parts.join(", ")}` : null;
}

/** The hand-off jobs of a run's rows summed: jobs, parts, the job advisor's calls, their spend, and per job. */
export function handoffOf(rows) {
  const sum = { jobs: 0, parts: 0, advisorCalls: 0, usd: 0 };
  for (const r of rows) {
    const h = r?.handoff;
    if (!h || typeof h !== "object") continue;
    for (const key of Object.keys(sum)) sum[key] += Number(h[key]) || 0;
  }
  const usd = Math.round(sum.usd * 10_000) / 10_000;
  return { ...sum, usd, perJobUsd: sum.jobs > 0 ? Math.round((sum.usd / sum.jobs) * 10_000) / 10_000 : 0, advisorCallsPerJob: sum.jobs > 0 ? Math.round((sum.advisorCalls / sum.jobs) * 100) / 100 : 0 };
}

/**
 * A row's detail: first "rounds: <used>/<of>, ..." with "ran out" or "handed off" on a turn that ran to its bound (Dev2,
 * 2026-11-18: "prove from traces which Training fd misses are round exhaustion"), then "route: pick ..., door ..." (`routeLine`),
 * then "steps: <what the turn did>" (the row's `steps`, `turnSteps.mjs`), then "never: <line> (<judge's reason>)" per failed line, "held: must: <line> (<reason>)" per
 * line that held, then "Tex: <texts>"; empty when there is none.
 */
export function roundsLine(rounds) {
  const list = Array.isArray(rounds) ? rounds : [];
  const runs = (list.some(Array.isArray) ? list : [list]).map((run) => (Array.isArray(run) ? run : []).filter((t) => t && Number.isInteger(t.used) && Number.isInteger(t.of))).filter((run) => run.length > 0);
  if (runs.length === 0) return null;
  const turn = (t) => `${t.used}/${t.of}${t.handedOff ? " handed off" : t.exhausted ? " ran out" : t.toEnd ? " reached its end" : ""}`;
  return `rounds: ${runs.map((run) => run.map(turn).join(", ")).join(" | ")}`; // turns of one run by commas, runs by bars
}

export function detailOf(r) {
  const line = (m) => `${m.kind === "must not" ? "never" : "must"}: ${m.line}${m.reason ? ` (${m.reason})` : ""}`;
  const misses = (Array.isArray(r.misses) ? r.misses : []).map(line);
  const held = (Array.isArray(r.held) ? r.held : []).map((m) => `held: ${line(m)}`);
  const said = Array.isArray(r.said) ? r.said.filter((t) => typeof t === "string") : [];
  const rounds = roundsLine(r.rounds);
  const route = routeLine(routeOf(r));
  // Before the judge's lines, so the cut never takes it: what the turn did, to read a quiet or missed row against.
  const steps = typeof r.steps === "string" && r.steps !== "" ? `steps: ${r.steps}` : null;
  const text = [...(rounds !== null ? [rounds] : []), ...(route !== null ? [route] : []), ...(steps !== null ? [steps] : []), ...misses, ...held, ...(said.length > 0 ? [`Tex: ${said.join(" / ")}`] : [])].join("\n").slice(0, DETAIL_CHARS);
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
    const training = job.set === "training";
    const pick = training ? trainingConversations : devConversations;
    const convs = pick(await loadSets(), job.drafts, job.kind === "chat" ? job.convId : null);
    const name = training ? "Training" : "Dev";
    if (job.kind === "chat" && convs.length === 0) throw new Error(`${job.convId} is not a ${name} conversation`);
    const lost = uncast(convs, parsePeople(readFileSync(PEOPLE, "utf8")), job.nodeId || null);
    if (lost.length > 0) {
      throw new Refused(
        `${lost.length} ${name} conversation${lost.length === 1 ? "" : "s"} can't run the Front door's tests (${lost.map((x) => x.id).join(", ")}): people with no bench world or shared workspace`,
        `the Front door's tests can't run: ${lost.map((x) => `${x.id}: ${x.problems.join("; ")}`).join(" | ")} (the bench's people: apps/mcp/bench/ai/workspaces/people.md)`,
      );
    }
    writeFileSync(join(b, "convs.json"), JSON.stringify(convs));
    if (job.graph) writeFileSync(join(b, "graph.json"), job.graph);
    console.log(`${name} conversations: ${convs.length} (${convs.map((c) => c.id).join(", ")}); ${job.graph ? "draft graph" : "main"}`);
    return;
  }
  if (sub === "results") {
    // The optional gold report (`apps/mcp/bench/setsGold.mjs`): a path that does not exist is no gold.
    const gold = process.argv[5] && existsSync(process.argv[5]) ? JSON.parse(readFileSync(process.argv[5], "utf8")) : null;
    process.stdout.write(JSON.stringify(resultsOf(JSON.parse(readFileSync(a, "utf8")), b, gold)));
    return;
  }
  if (sub === "ran") {
    const none = unrun(JSON.parse(readFileSync(a, "utf8")));
    if (none.length > 0) {
      throw new Refused(
        `none of these steps' tests could run: ${none.map((x) => `${x.node} 0/${x.total}`).join(", ")}`,
        none.map((x) => `none of ${x.node}'s ${x.total} tests could run: ${x.why}`).join(" | "),
      );
    }
    // Out of credit, nothing a row says is Tex's: a failed run with why. Most of a step not running only marks it invalid.
    const rows = JSON.parse(readFileSync(a, "utf8"));
    const broken = brokenRun(rows);
    if (broken?.startsWith("Claude calls could not run")) {
      const out = rows.filter((r) => r.ran === false && /credit/i.test(String(r.why ?? ""))).length;
      throw new Refused(`Claude calls ran out of credit: ${out} of ${rows.length} tests could not run`, broken);
    }
    console.log("Every step with tests ran some");
    return;
  }
  throw new Error("usage: tex-lab-run.mjs prepare <job.json> <dir> | results <rows.json> <ms> [gold.json] | ran <rows.json>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`tex-lab-run: ${error.message}`);
    // The Lab's copy of why (private, at most the 280 characters the workflow reports); never the reason this exits.
    try {
      if (process.env.TEX_LAB_WHY) writeFileSync(process.env.TEX_LAB_WHY, String(error.why ?? error.message).slice(0, 280));
    } catch {}
    process.exit(1);
  });
}
