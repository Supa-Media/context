/**
 * A NODE ALONE ON ITS UNIT TESTS (Dev2, 2026-11-15: "unit tests should be marked per message, per node"; plan
 * /mnt/project-files/tex-sets/plan.md: "run that node alone on every gated change, given everything before the
 * message, its config context modules, and its wires' inputs").
 *
 *   node apps/mcp/bench/run.mjs sets run --conversations <file.json> --tree <dir> --out <file.json> [--node <id>] [--repeat n] [--fake]
 *   pnpm ai sets run [--set dev] [--node decide] [--repeat n] [--fake] [--out <file.json>]   (the repo's Dev Set by default)
 *   pnpm ai sets run --set dev --node fd --world record|refresh   record the simulated world's answers as fixtures
 *     (`simFixtures.mjs`, apps/mcp/bench/sets/sim/<conversation>.json): record adds this run's misses, refresh re-asks
 *     every call; commit the files. Every other run replays them and reports its misses (`world:` line).
 *
 * Each Front door test runs `--repeat n` times (or TEX_SETS_REPEAT): a whole number 1..5, 3 by default (Dev2, 2026-11-19:
 * one Front door run came back 11/30 and 15/30 minutes apart, so a run's score is a mean over repeats with its band).
 * Each copy's row carries its repeat as `rep` (0-based); the other nodes run once and carry none. `scoreByRepeat` reads
 * the rows back as per-repeat pass counts for the band.
 *
 * A unit test is a starred label: one person's message × one node (`texSets.cjs` `unitTests`). Each runs through
 * that node's own code from `--tree` (the checkout whose nodes are judged), put the way production puts it, with
 * this file's harness doing the reading and scoring (so a branch can't change what holds sealed cases). Its input is
 * the conversation before the message, and from the node feeding it, that node's label on the message if one is
 * set, else its recorded run on main (`rec[node]`, frozen).
 *
 * The answer is one row a test, written only to `--out`: { chat, msg, node, right, ran, usd, why? }. Standard output
 * says counts by node, never a message's words, so a sealed Test Set can run through it (the eval service).
 * A node without a way to run alone yet says so (`ran: false`) instead of passing.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runFd } from "./setsFd.mjs";
import { worldMode } from "./simFixtures.mjs";

const require = createRequire(import.meta.url);
const { unitTests, TEX } = require("../../../packages/shared/src/texSets.cjs");
const { routeSummary } = require("../../../packages/shared/src/texRouteSummary.cjs");
const { DEFAULT_REPEATS, MAX_REPEATS, repeatsOf, bandOf, CC_FIDELITY, CC_FIDELITY_WHY } = require("../../../packages/shared/src/texRunBand.cjs");

/** Rough prices to report spend by: Clef on Workers AI and Haiku through the AI gateway, per call. */
const USD = { decide: 0.0004, reviewer: 0.002 };

const at = (handle) => "@" + String(handle).toLowerCase().replace(/\s+/g, "");
/**
 * Whether Decide put a reaction on the message: its own also_react answer, which it gives beside any act (reacting
 * is its own decision, Dev2 2026-11-01). The verdict carries it as the emoji it picked; a quiet one that reacts reads
 * "react". Reading only act === "react" scored every respond-and-react label wrong whatever Decide answered.
 */
export const reactsIn = (verdict) => verdict?.act === "react" || typeof verdict?.emoji === "string";

const snip = (s, n = 60) => (String(s ?? "").length > n ? String(s).slice(0, n - 1) + "…" : String(s ?? ""));

/** One message as the judge reads a chat line (`textDecide.cjs` JUDGE_EXAMPLES): "@who: words", Tex as "You". */
export function lineOf(c, m) {
  const byId = (id) => (c.msgs || []).find((x) => x.id === id);
  const who = m.tex || m.who === TEX ? "You" : at(m.who);
  const to = m.to ? byId(m.to) : null;
  const toWho = to ? (to.tex ? "Tex's" : "the") : "the";
  switch (m.kind) {
    case "react":
      return `${who}: ${m.text || "👍"} on ${toWho} message "${snip(to?.text)}"`;
    case "reply":
      return `${who}: (replying to ${to ? (to.tex ? "You" : at(to.who)) : "a message"}) ${m.text}`;
    case "edit":
      return `${who}: (edited "${snip(to?.text, 40)}" to) ${m.text}`;
    case "delete":
      return `${who}: (deleted "${snip(to?.text, 40)}")`;
    default:
      return `${who}: ${m.text}${picsNote(m)}`;
  }
}

/** A message's pictures as a chat line reads them: the judge sees text, so it is told a picture came with it. */
function picsNote(m) {
  const n = Array.isArray(m.pics) ? m.pics.length : 0;
  if (!n) return "";
  return `${m.text ? " " : ""}(sent ${n === 1 ? "a picture" : n + " pictures"})`;
}

/** The respond bench's case for Decide on message `i` (`respond.mjs` caseBody reads it). */
export function decideCase(c, i) {
  return {
    id: `${c.id}/${c.msgs[i].id}`,
    chat: c.kind === "group" ? "group" : "one",
    ...(c.setting ? { setting: c.setting } : {}),
    lines: c.msgs.slice(0, i).map((m) => lineOf(c, m)),
    text: lineOf(c, c.msgs[i]),
  };
}

/** What Decide said and what its label wants, short, for a Lab run's row (`scripts/tex-lab-run.mjs`). */
export function decideSaid(label, verdict) {
  if (!verdict || verdict.ok !== true) return { got: "no verdict", want: String(label.act ?? "any") };
  // Every field the label names, as "field value", so a miss shows where it differs (act alone hid a why miss).
  const got = { act: verdict.act === "answer" ? "respond" : verdict.act === "wait" ? "wait" : "quiet", also_react: reactsIn(verdict) ? "yes" : "no", why: verdict.why ?? "none", moved_on: verdict.movedOn ? "yes" : "no" };
  const fields = Object.keys(got).filter((f) => label[f] !== undefined && label[f] !== "any");
  const line = (pick) => fields.map((f) => (f === "act" ? pick(f) : `${f} ${pick(f)}`)).join(", ");
  return { got: line((f) => got[f]), want: line((f) => label[f]) };
}

/** Whether Decide's verdict matches the label: each labelled field, "any" skipped. */
export function decideRight(label, verdict) {
  if (!verdict || verdict.ok !== true) return { right: false, why: "no verdict" };
  const act = verdict.act === "answer" ? "respond" : verdict.act === "wait" ? "wait" : "quiet";
  const reacts = reactsIn(verdict) ? "yes" : "no";
  const misses = [];
  const want = (field, got) => {
    const w = label[field];
    if (w !== undefined && w !== "any" && w !== got) misses.push(`${field} ${got}, wanted ${w}`);
  };
  want("act", act);
  want("also_react", reacts);
  want("why", verdict.why ?? "none");
  want("moved_on", verdict.movedOn ? "yes" : "no");
  return { right: misses.length === 0, why: misses.join("; ") };
}

/** The review bench's case for the reviewer on message `i`: the draft is the front door's label or its recorded run. */
export function reviewerCase(c, i) {
  const m = c.msgs[i];
  const rec = (m.rec || {}).fd || {};
  const earlier = c.msgs.slice(0, i).filter((x) => !x.kind).map((x) => [x.tex ? "tex" : "person", x.text]);
  return { id: `${c.id}/${m.id}`, q: m.text, earlier, did: Array.isArray(rec.did) ? rec.did : [], reply: rec.draft ?? "" };
}

/** Whether the reviewer's call matches sentBack: "0" lets the draft go, "1" or "2+" sends it back. */
export function reviewerRight(label, verdict) {
  if (!verdict) return { right: false, why: "no verdict" };
  const sentBack = verdict.send === false;
  const want = label.sentBack;
  if (want === undefined || want === "any") return { right: true, why: "" };
  const right = want === "0" ? !sentBack : sentBack;
  return { right, why: right ? "" : sentBack ? "sent it back, wanted it to go" : "let it go, wanted it sent back" };
}

/**
 * The router's case for message `i`: the message's words as the question, whether the chat is a group, the trigger
 * that started the turn (a check-in or a routine is its own; every other message, a text), and the parts its config
 * `ctx` reads (`routerContext.js`), as the bench gives Decide its chat: the conversation before the message as the
 * judge reads a chat line (`lineOf`), its time as the date, and `training`, the Training module the router reads for
 * this conversation (`routeTraining`). The bench has no ledger, so no day summaries and no facts of the moment.
 */
export function routeCase(c, i, { ctx = [], training = null } = {}) {
  const m = c.msgs[i];
  const trigger = m.via === "checkin" || m.via === "routine" ? m.via : "text";
  const history = c.msgs.slice(0, i).map((x) => lineOf(c, x)).join("\n");
  const today = typeof m.at === "string" && m.at.trim() !== "" ? m.at.trim() : "";
  return { question: String(m.text ?? ""), group: c.kind === "group", trigger, context: { ctx, training, history, facts: [], today } };
}

/**
 * The Training module the router reads on message `i` of `c`, as the front door's is in its bench (`setsFd.mjs`): with
 * the hold-out on, every conversation but this one; off, this one ended at the message (`texTraining.cjs` `cutAt`), so
 * no example shows its own label or what came after. Any other conversation's examples are all of them.
 */
export function routeTraining(c, i, generated, { holdOut = false, withoutChat, cutAt }) {
  if (c.set !== "training" || !generated) return generated;
  const drop = holdOut ? withoutChat : cutAt;
  if (typeof drop !== "function") return null; // a tree without the cut reads no examples rather than this chat's own
  return holdOut ? withoutChat(generated, c.id) : cutAt(generated, c.id, i);
}

/** Whether the router's pick is the labelled route. No pick is wrong, and says so. */
export function routeRight(label, pick) {
  const right = pick === label.route;
  return { right, why: right ? "" : pick ? `routed ${pick}, wanted ${label.route}` : `no route, wanted ${label.route}` };
}

/** The router's code, as a tree has it: the module that builds its question and reads its answer (`specialistRoute.js`). */
const ROUTER_MODULE = "apps/mcp/src/agent/specialistRoute.js";
/** The tree's config, Training code and Training module, for the router's context modules. */
const TREE_CONFIG = "packages/shared/src/texConfig.cjs";
const TREE_TRAINING = "packages/shared/src/texTraining.cjs";
const TREE_GENERATED = "packages/shared/src/texTraining.generated.json";

/** Each node's way to run alone: how to ask it, given the tree's code, and how to score its answer. */
export async function adaptersFor(tree, { fake = false, env = process.env, holdOut = false, routeEngine = null, world = "replay" } = {}) {
  const mod = (rel) => import(pathToFileURL(join(tree, rel)).href);
  // Claude's calls through the model socket when one is set (`modelSocket.mjs`): the Lab's Claude Code runs
  // (`tex-lab-run.yml`, models "cc") answer them with `socketAnswerer.mjs`; nothing is priced then.
  const { modelSocket, socketRequest } = await import("./modelSocket.mjs");
  const socket = fake ? null : modelSocket(env);
  const socketed = Boolean(socket?.covers("claude"));
  const table = {
    // The front door runs as a whole turn in the bench's world, so its tests go as one batch (`setsFd.mjs`).
    fd: { batch: (units, { parallel = 1 } = {}) => runFd(units, { tree, fake, parallel, holdOut, env, world }) },
    decide: async () => {
      const { judgeCase, fakeEngine } = await mod("apps/mcp/bench/respond.mjs");
      const engine = fake ? null : (await mod("apps/mcp/src/agent/decide.js")).decisionEngine((await mod("apps/mcp/bench/models.mjs")).workersAi(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_AI_TOKEN));
      return async (c, i, label) => {
        const item = decideCase(c, i);
        if (fake && label.act === "wait") return { right: true, ran: true, usd: 0 };
        if (fake) {
          const want = label.act === "respond" ? "reply" : "hush";
          const verdict = await judgeCase(item, fakeEngine([{ ...item, want }]));
          const r = decideRight({ act: label.act }, verdict);
          return { ...r, ran: true, usd: 0 };
        }
        const verdict = await judgeCase(item, engine);
        return { ...decideRight(label, verdict), ...decideSaid(label, verdict), ran: true, usd: USD.decide };
      };
    },
    // The job check at a job's stop: the job from its recorded run (rec.job: title, brief, doneWhen, did), the
    // person's asks as the chat's texts before it, through the advisor bench's own asking (`advisor.mjs`).
    jobcheck: async () => {
      const { ROLES, fakeRequest, ADVISOR_MODEL } = await mod("apps/mcp/bench/advisor.mjs");
      const { aiGatewayConfig, requestViaGateway } = await mod("apps/mcp/src/agent/aiGateway.js");
      const { priceUsd } = await mod("apps/mcp/bench/report.mjs");
      const config = fake ? null : aiGatewayConfig(env);
      const role = ROLES["advisor-job-check"];
      return async (c, i, label) => {
        const rec = (c.msgs[i].rec || {}).job;
        if (!rec) return { right: false, ran: false, usd: 0, why: "no job: record the job's run (rec.job) on this message" };
        const asked = c.msgs.slice(0, i + 1).filter((m) => !m.tex && !m.kind).map((m) => m.text);
        // A job row (via "job") is the job's own report: its words are the answer the check reads.
        const answer = c.msgs[i].via === "job" ? String(c.msgs[i].text ?? "") : rec.answer;
        const item = { job: { title: rec.title, brief: rec.brief, doneWhen: rec.doneWhen, asked }, did: rec.did ?? [], ...(answer ? { answer } : {}), ...(rec.exhausted ? { exhausted: true } : {}), want: label.verdict };
        if (!fake && !socketed && config === null) return { right: false, ran: false, usd: 0, why: "no AI gateway (AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN)" };
        const request = fake ? fakeRequest("advisor-job-check", item) : socketed ? socketRequest(socket) : (params) => requestViaGateway(params, config, { metadata: { feature: "bench", client: "sets" } });
        const out = await role.ask(item, request);
        const right = label.verdict === undefined || label.verdict === "any" || out.got === label.verdict;
        return { right, ran: true, usd: socketed ? 0 : (priceUsd && priceUsd(ADVISOR_MODEL, out.usage)) || 0, got: String(out.got ?? ""), want: String(label.verdict ?? "any"), ...(right ? {} : { why: `said ${out.got}, wanted ${label.verdict}` }) };
      };
    },
    reviewer: async () => {
      const { caseTurn } = await mod("apps/mcp/bench/review.mjs");
      const { reviewReply } = await mod("apps/mcp/src/agent/replyJudge.js");
      const { aiGatewayConfig } = await mod("apps/mcp/src/agent/aiGateway.js");
      const config = fake ? null : aiGatewayConfig(env);
      return async (c, i, label) => {
        const item = reviewerCase(c, i);
        if (!item.reply) return { right: false, ran: false, usd: 0, why: "no draft: label the front door or record its run on this message" };
        if (fake) return { ...reviewerRight(label, { send: label.sentBack === "0" }), ran: true, usd: 0 };
        if (config === null && !socketed) return { right: false, ran: false, usd: 0, why: "no AI gateway (AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_ID, AI_GATEWAY_TOKEN)" };
        const verdict = await reviewReply({ state: caseTurn(item), config, metadata: { feature: "bench", client: "sets" }, ...(socketed ? { request: socketRequest(socket) } : {}) }).catch(() => null);
        const said = { got: !verdict ? "no verdict" : verdict.send === false ? "sent back" : "let go", want: label.sentBack === undefined || label.sentBack === "any" ? "any" : label.sentBack === "0" ? "let go" : "sent back" };
        return { ...reviewerRight(label, verdict), ...said, ran: true, usd: socketed ? 0 : USD.reviewer };
      };
    },
  };
  // The router alone: its question and reader from the tree (`routeRequest`, `readRoute`), asked of the same Clef
  // engine Decide is asked on (`decisionEngine` over `workersAi`). A tree without the module says so on each row.
  table.router = async () => {
    if (!existsSync(join(tree, ROUTER_MODULE))) {
      return () => ({ right: false, ran: false, usd: 0, why: `router can't run alone yet: ${ROUTER_MODULE} is not in this tree` });
    }
    const { routeRequest, readRoute } = await mod(ROUTER_MODULE);
    // The router's context modules as the tree's config names them, with the tree's own Training module.
    const ctx = existsSync(join(tree, TREE_CONFIG)) ? (require(join(tree, TREE_CONFIG)).TEX_CONFIG?.nodes?.find((n) => n.id === "router")?.ctx ?? []) : [];
    const training = existsSync(join(tree, TREE_TRAINING)) ? require(join(tree, TREE_TRAINING)) : null;
    const generated = existsSync(join(tree, TREE_GENERATED)) ? JSON.parse(await readFile(join(tree, TREE_GENERATED), "utf8")) : null;
    // Without the Clef credentials the engine answers nothing, which would score every row wrong rather than not run.
    if (!fake && !routeEngine && !(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN)) {
      return () => ({ right: false, ran: false, usd: 0, why: "no Clef engine: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are not set" });
    }
    const engine = routeEngine ?? (fake ? null : (await mod("apps/mcp/src/agent/decide.js")).decisionEngine((await mod("apps/mcp/bench/models.mjs")).workersAi(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_AI_TOKEN)));
    return async (c, i, label) => {
      // The fake run answers what the label says, as Decide's does: right by construction, and it proves the wiring.
      if (fake) return { ...routeRight(label, label.route), got: label.route, want: label.route, route: { pick: label.route, sure: null }, ran: true, usd: 0 };
      const { state, questions } = routeRequest(routeCase(c, i, { ctx, training: training ? routeTraining(c, i, generated, { holdOut, withoutChat: training.withoutChat, cutAt: training.cutAt }) : null }));
      const read = readRoute(await engine(state, questions));
      const pick = read?.route ?? null;
      const sure = typeof read?.sure === "number" ? read.sure : null;
      return { ...routeRight(label, pick), got: pick, want: label.route, route: { pick, sure }, ran: true, usd: 0 };
    };
  };
  // The live Job advisor runs the same check (`graph/nodes/jobcheck.js`), labelled under its own id.
  table.jobadv = table.jobcheck;
  return table;
}

/**
 * Every unit test of the conversations (one node when `node` is named), each run alone. The nodes that run in this
 * process (Decide, the job check, the reviewer) go one after another while the batched ones (the Front door, whose
 * tests are processes of their own) go beside them, `parallel` tests at a time; rows come back in the same order.
 */
export async function runSets(convs, { tree, node = null, fake = false, env = process.env, adapters = null, parallel = 1, holdOut = false, repeats = 1, world = "replay" } = {}) {
  const table = adapters ?? (await adaptersFor(tree, { fake, env, holdOut, world }));
  const ready = {};
  const singles = [];
  const batches = {};
  for (const c of convs) {
    for (const t of unitTests(c)) {
      if (node && t.node !== node) continue;
      const label = c.msgs[t.at].labels[t.node];
      const row = { chat: c.id, msg: t.msg, at: t.at, node: t.node };
      if (table[t.node]?.batch) {
        // The Front door's tests go `repeats` times, each copy its own object with its repeat's number (Dev2, 2026-11-19).
        const copies = t.node === "fd" ? repeats : 1;
        for (let rep = 0; rep < copies; rep++) {
          (batches[t.node] ??= []).push({ convo: c, at: t.at, label, row: t.node === "fd" ? { ...row, rep } : { ...row } });
        }
      } else singles.push({ c, t, label, row });
    }
  }
  const alone = async () => {
    const rows = [];
    for (const { c, t, label, row } of singles) {
      if (!table[t.node]) {
        rows.push({ ...row, right: false, ran: false, usd: 0, why: `${t.node} can't run alone yet: it runs in the whole-turn replay` });
        continue;
      }
      try {
        ready[t.node] ??= await table[t.node]();
        rows.push({ ...row, ...(await ready[t.node](c, t.at, label)) });
      } catch (error) {
        rows.push({ ...row, right: false, ran: false, usd: 0, why: `could not run: ${String(error?.message ?? error).slice(0, 300)}` });
      }
    }
    return rows;
  };
  const batched = Object.entries(batches).map(async ([n, units]) => {
    try {
      return await table[n].batch(units, { parallel });
    } catch (error) {
      return units.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `could not run: ${String(error?.message ?? error).slice(0, 300)}` }));
    }
  });
  const [first, ...rest] = await Promise.all([alone(), ...batched]);
  return [...first, ...rest.flat()];
}

/**
 * The calls the world had no fixture for, deduped by conversation, kind and call: `[{ chat, kind, call }]`. Each unit of a
 * test carries its test's calls, so one call would count once per unit without this. Rows without `world` contribute nothing.
 */
export function worldMisses(rows) {
  const seen = new Map();
  for (const r of rows) {
    for (const c of Array.isArray(r.world?.calls) ? r.world.calls : []) {
      const key = `${r.chat}\n${c.kind}\n${c.call}`;
      if (!seen.has(key)) seen.set(key, { chat: r.chat, kind: c.kind, call: c.call });
    }
  }
  return [...seen.values()];
}

/**
 * The world's line for standard output: counts and kinds only, never a call's text. "" when no row has a `world`.
 * A row with none (a node that has no Front door test) says nothing about the world.
 */
export function worldLine(rows) {
  if (!rows.some((r) => r.world)) return "";
  const misses = worldMisses(rows);
  if (misses.length === 0) return "world: every simulated call replayed from fixtures";
  const by = {};
  for (const m of misses) by[m.kind] = (by[m.kind] ?? 0) + 1;
  const kinds = Object.entries(by)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  return `world: ${misses.length} simulated call(s) not in fixtures (${kinds})`;
}

/** A unit test's key: its chat, message index and node. Its repeats share it. */
export const testKeyOf = (r) => `${r.chat}\u0000${r.at ?? 0}\u0000${r.node}`;

/** A row's repeat as a number: its `rep` when it has one, else 0 (a node that runs once, or a row from before repeats). */
const repOf = (r) => (Number.isInteger(Number(r?.rep)) && Number(r.rep) >= 0 ? Number(r.rep) : 0);

/**
 * The rows of a run read as per-repeat pass counts (Dev2, 2026-11-19: "repeat each Front door row N times ... a draft
 * wins only if it clears the band"). Rows group into unit tests by `testKeyOf`; a test whose rows all could not run is
 * left out. A test's pass rate is its passed runs over its runs. The repeats are 0..k-1, k being 1 plus the highest
 * `rep` in the rows. At repeat r a test counts 1 or 0 by its row at that repeat when it ran there, else its pass rate
 * (a node that runs once, or a repeat that did not run). Pass the rows to read: a node's or a chat's, filtered first.
 * Returns { tests: [{chat, at, node, runs, passes, rate}], perRepeat, score: bandOf(perRepeat, tests), repeats: k }.
 */
export function scoreByRepeat(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const r of list) {
    const key = testKeyOf(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const repeats = 1 + list.reduce((m, r) => Math.max(m, repOf(r)), 0);
  const tests = [];
  for (const g of groups.values()) {
    const ran = g.filter((r) => r.ran !== false);
    if (ran.length === 0) continue;
    const passes = ran.filter((r) => r.right).length;
    const first = ran[0];
    // Each counted test with its first ran row at each repeat, for the per-repeat count below.
    const ranAt = new Map();
    for (const r of ran) if (!ranAt.has(repOf(r))) ranAt.set(repOf(r), r);
    tests.push({ chat: first.chat, at: first.at, node: first.node, runs: ran.length, passes, rate: passes / ran.length, byRep: ranAt });
  }
  const perRepeat = [];
  for (let r = 0; r < repeats; r++) {
    perRepeat.push(tests.reduce((a, t) => a + (t.byRep.has(r) ? (t.byRep.get(r).right ? 1 : 0) : t.rate), 0));
  }
  const tidy = tests.map(({ byRep, ...t }) => t);
  return { tests: tidy, perRepeat, score: bandOf(perRepeat, tests.length), repeats };
}

/**
 * Counts by node, never words: what standard output may say. Each node counts its own rows only (the router's count is
 * its router rows, never an fd row's pick). When the front door's rows carry route records, the line adds how many
 * turns a specialist door ran and how many fell back: the same `fallback` figure the Lab's "By route" block shows.
 * A node that repeated says its band over its repeats.
 */
export function countsLine(rows) {
  const by = {};
  for (const r of rows) {
    const b = (by[r.node] ??= { right: 0, ran: 0, all: 0 });
    b.all += 1;
    if (r.ran) b.ran += 1;
    if (r.right) b.right += 1;
  }
  const usd = rows.reduce((a, r) => a + (r.usd || 0), 0);
  const { fallback } = routeSummary(rows, () => null);
  const doors = fallback.total > 0 ? [`doors ${fallback.specialist}/${fallback.total} specialist (${fallback.fellBack} fell back)`] : [];
  return Object.entries(by)
    .map(([n, b]) => {
      const { score, repeats } = scoreByRepeat(rows.filter((r) => r.node === n));
      const band = repeats > 1 ? ` (${score.min}–${score.max} over ${repeats} repeats)` : "";
      return `${n} ${b.right}/${b.all}${band}${b.ran < b.all ? ` (${b.all - b.ran} can't run alone)` : ""}`;
    })
    .concat(doors, `$${usd.toFixed(4)}`)
    .join(" · ");
}

/** Whether the hold-out switch's value means on. */
export const holdOutOn = (value) => /^(?:on|yes|true|1)$/i.test(String(value ?? "").trim());

/** `sets run`: the CLI half. */
export async function setsCommand(sub, options, { write = (t) => process.stdout.write(t) } = {}) {
  const usage = "usage: sets run [--conversations <file.json>] [--set dev] [--tree <dir>] [--node <id>] [--out <file.json>] [--parallel n] [--hold-out on] [--repeat n] [--world replay|record|refresh] [--fake]";
  if (sub !== "run") throw new Error(usage);
  // Each Front door test's repeats (Dev2, 2026-11-19): --repeat, else TEX_SETS_REPEAT, else 3; a whole number 1..5. A bare
  // `--repeat` (no value) is refused, not read as 1 or as the default.
  // `run.mjs` reads a flag with no value as undefined, so a key that is there with no value is refused too.
  const given = "repeat" in options;
  const asked = given ? options.repeat : process.env.TEX_SETS_REPEAT;
  const repeats = asked === true || (given && asked === undefined) ? null : repeatsOf(asked);
  if (repeats === null) throw new Error(`${usage}\n--repeat takes a whole number from 1 to ${MAX_REPEATS} (default ${DEFAULT_REPEATS}), got ${JSON.stringify(asked)}`);
  // The world's mode: replay (the default) answers from the repo's fixtures; record and refresh write them, so they
  // only ever run on the repo's own sets, never on a file handed in (which may be sealed).
  const world = worldMode(options.world ?? process.env.TEX_SETS_WORLD);
  if (world !== "replay" && options.conversations) throw new Error("--world record|refresh writes the repo's fixtures, so it runs on the repo's sets only (--set), never a handed-in or sealed file");
  let convs;
  if (options.conversations) convs = JSON.parse(await readFile(resolve(options.conversations), "utf8"));
  else {
    const { loadSets } = await import("./sets.mjs");
    const set = options.set ?? "dev";
    convs = (await loadSets()).filter((c) => c.set === set);
  }
  if (!Array.isArray(convs)) throw new Error("--conversations is a JSON list of conversations");
  const tree = resolve(options.tree ?? join(import.meta.dirname, "../../.."));
  // Front door tests at once: each is a process waiting on models, and the Lab's runner has room for these.
  const parallel = Math.max(1, Math.min(Number(options.parallel ?? 8) || 1, 16));
  // The hold-out switch (Seyi, 2026-11-17: "keep the hold-out as a switch, and report both Training numbers"): off, a
  // Training conversation's Front door tests read it among their examples, as production does (the in-context score);
  // on (`--hold-out on`, or TEX_SETS_HOLD_OUT=on, the Lab run workflow's repository variable), each runs without its
  // own conversation (the held-out score). It changes nothing for a Dev conversation, which is never an example.
  const holdOut = holdOutOn(options["hold-out"] ?? process.env.TEX_SETS_HOLD_OUT);
  const rows = await runSets(convs, { tree, node: options.node ?? null, fake: Boolean(options.fake), parallel, holdOut, repeats, world });
  if (convs.some((c) => c.set === "training")) write(`Training Front door: ${holdOut ? "held out (each conversation left out of its own examples)" : "in context (each conversation among its own examples)"}\n`);
  // A run on Claude Code says what it is: the same model family, not the production version (`texRunBand.cjs`).
  const { modelSocket } = await import("./modelSocket.mjs");
  const socket = options.fake ? null : modelSocket(process.env);
  if (socket?.covers("claude")) write(`Models: Claude Code (cc), ${CC_FIDELITY}: ${CC_FIDELITY_WHY}\n`);
  if (options.out) await writeFile(resolve(options.out), JSON.stringify(rows, null, 1) + "\n");
  write(`${countsLine(rows)}\n`);
  const worldText = worldLine(rows);
  if (worldText !== "") write(`${worldText}\n`);
  // The repo's sets name what missed (their words are public); a file handed in may be sealed, so it never does.
  if (!options.conversations && !options.out) {
    for (const r of rows.filter((x) => !x.right)) write(`MISS ${r.chat}/${r.msg} ${r.node}: ${r.why ?? ""}\n`);
    for (const m of worldMisses(rows)) write(`WORLD MISS ${m.chat} ${m.kind} ${m.call}\n`);
  }
  return rows;
}
