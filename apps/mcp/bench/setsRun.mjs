/**
 * A NODE ALONE ON ITS UNIT TESTS (Dev2, 2026-11-15: "unit tests should be marked per message, per node"; plan
 * /mnt/project-files/tex-sets/plan.md: "run that node alone on every gated change, given everything before the
 * message, its config context modules, and its wires' inputs").
 *
 *   node apps/mcp/bench/run.mjs sets run --conversations <file.json> --tree <dir> --out <file.json> [--node <id>] [--fake]
 *   pnpm ai sets run [--set dev] [--node decide] [--fake] [--out <file.json>]      (the repo's Dev Set by default)
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
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { unitTests, TEX } = require("../../../packages/shared/src/texSets.cjs");

/** Rough prices to report spend by: Clef on Workers AI and Haiku through the AI gateway, per call. */
const USD = { decide: 0.0004, reviewer: 0.002 };

const at = (handle) => "@" + String(handle).toLowerCase().replace(/\s+/g, "");
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
  const got = { act: verdict.act === "answer" ? "respond" : verdict.act === "wait" ? "wait" : "quiet", also_react: verdict.act === "react" ? "yes" : "no", why: verdict.why ?? "none", moved_on: verdict.movedOn ? "yes" : "no" };
  const fields = Object.keys(got).filter((f) => label[f] !== undefined && label[f] !== "any");
  const line = (pick) => fields.map((f) => (f === "act" ? pick(f) : `${f} ${pick(f)}`)).join(", ");
  return { got: line((f) => got[f]), want: line((f) => label[f]) };
}

/** Whether Decide's verdict matches the label: each labelled field, "any" skipped. */
export function decideRight(label, verdict) {
  if (!verdict || verdict.ok !== true) return { right: false, why: "no verdict" };
  const act = verdict.act === "answer" ? "respond" : verdict.act === "wait" ? "wait" : "quiet";
  const reacts = verdict.act === "react" ? "yes" : "no";
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
 * The front door's unit tests as one bench test in the invented Maya world (`coreArea.mjs` runs it in `tree`): each a
 * question with its must and never lines, the person's words as they start it. Only a one-ask chat in that world can
 * run this way; any other says so.
 */
export function fdTest(units, front) {
  const out = [`---\n${front}\n---\n\n# Sets\n\nThe front door's unit tests from the test conversations (setsRun.mjs).\n`];
  units.forEach((u, k) => {
    const m = u.convo.msgs[u.at];
    const l = u.label;
    out.push(`## ${k + 1}. ${String(m.text).replace(/\s+/g, " ").slice(0, 120)}\n\n- kind: task\n- person starts: ${JSON.stringify(m.text)}\n${(l.must || []).map((x) => `- must: ${x}\n`).join("")}${(l.never || []).map((x) => `- must not: ${x}\n`).join("")}`);
  });
  return out.join("\n");
}

const fdAlone = (c, i) => c.world === "maya" && c.msgs.slice(0, i).every((m) => m.tex) && !c.msgs[i].kind;

/** Each node's way to run alone: how to ask it, given the tree's code, and how to score its answer. */
export async function adaptersFor(tree, { fake = false, env = process.env } = {}) {
  const mod = (rel) => import(pathToFileURL(join(tree, rel)).href);
  // Claude's calls through the model socket when one is set (`modelSocket.mjs`): the Lab's Claude Code runs
  // (`tex-lab-run.yml`, models "cc") answer them with `socketAnswerer.mjs`; nothing is priced then.
  const { modelSocket, socketRequest } = await import("./modelSocket.mjs");
  const socket = fake ? null : modelSocket(env);
  const socketed = Boolean(socket?.covers("claude"));
  return {
    // The front door runs its whole turn's tools, so its tests go as one batch through the core bench.
    fd: {
      batch: async (units) => {
        const can = units.filter((u) => fdAlone(u.convo, u.at));
        const rows = units.filter((u) => !can.includes(u)).map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: "the front door runs alone only on a one-ask chat in the bench's Maya world (world: maya) for now" }));
        if (!can.length) return rows;
        // The texting setup is pulled into the tree before a core run (the replay gate's tex-replay.yml does), never kept
        // in the repo; without it the front door has nothing to run as.
        const setup = join(tree, "apps/mcp/bench/ai/setups/texting-assistant");
        if (!(await readFile(join(setup, "production.md"), "utf8").then(() => true, () => false)))
          return rows.concat(can.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: "the front door needs the texting setup pulled into the tree first (apps/mcp/bench/ai/setups/texting-assistant, as the replay gate pulls it)" })));
        const { runTests } = await mod("apps/mcp/bench/coreArea.mjs");
        const scratch = await mkdtemp(join(tmpdir(), "tex-sets-fd-"));
        const dir = join(scratch, "ai");
        await cp(join(tree, "apps/mcp/bench/ai"), dir, { recursive: true });
        const core = await readFile(join(dir, "tests", "core.md"), "utf8");
        const front = /^---\n([\s\S]*?)\n---/.exec(core)?.[1] ?? "";
        await writeFile(join(dir, "tests", "sets.md"), fdTest(can, front.replace(/^runs: .*$/m, "runs: 1")));
        const got = await runTests(tree, ["sets"], { dir, scratch, tag: "sets", fake });
        const each = got.usd / can.length;
        can.forEach((u, k) => {
          const r = got.rows.find((x) => x.id === `sets/q${k + 1}`);
          rows.push({ ...u.row, right: Boolean(r?.right), ran: Boolean(r), usd: Math.round(each * 10000) / 10000, ...(r?.right ? {} : { why: r ? "a must or never line failed" : "no judged answer" }) });
        });
        return rows;
      },
    },
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
        const item = { job: { title: rec.title, brief: rec.brief, doneWhen: rec.doneWhen, asked }, did: rec.did ?? [], want: label.verdict };
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
}

/** Every unit test of the conversations (one node when `node` is named), each run alone. */
export async function runSets(convs, { tree, node = null, fake = false, env = process.env, adapters = null } = {}) {
  const table = adapters ?? (await adaptersFor(tree, { fake, env }));
  const ready = {};
  const rows = [];
  const batches = {};
  for (const c of convs) {
    for (const t of unitTests(c)) {
      if (node && t.node !== node) continue;
      const label = c.msgs[t.at].labels[t.node];
      const row = { chat: c.id, msg: t.msg, at: t.at, node: t.node };
      if (table[t.node]?.batch) {
        (batches[t.node] ??= []).push({ convo: c, at: t.at, label, row });
        continue;
      }
      if (!table[t.node]) {
        rows.push({ ...row, right: false, ran: false, usd: 0, why: `${t.node} can't run alone yet: it runs in the whole-turn replay` });
        continue;
      }
      try {
        ready[t.node] ??= await table[t.node]();
        rows.push({ ...row, ...(await ready[t.node](c, t.at, label)) });
      } catch (error) {
        rows.push({ ...row, right: false, ran: false, usd: 0, why: `could not run: ${String(error?.message ?? error).slice(0, 200)}` });
      }
    }
  }
  for (const [n, units] of Object.entries(batches)) {
    try {
      rows.push(...(await table[n].batch(units)));
    } catch (error) {
      rows.push(...units.map((u) => ({ ...u.row, right: false, ran: false, usd: 0, why: `could not run: ${String(error?.message ?? error).slice(0, 200)}` })));
    }
  }
  return rows;
}

/** Counts by node, never words: what standard output may say. */
export function countsLine(rows) {
  const by = {};
  for (const r of rows) {
    const b = (by[r.node] ??= { right: 0, ran: 0, all: 0 });
    b.all += 1;
    if (r.ran) b.ran += 1;
    if (r.right) b.right += 1;
  }
  const usd = rows.reduce((a, r) => a + (r.usd || 0), 0);
  return Object.entries(by)
    .map(([n, b]) => `${n} ${b.right}/${b.all}${b.ran < b.all ? ` (${b.all - b.ran} can't run alone)` : ""}`)
    .concat(`$${usd.toFixed(4)}`)
    .join(" · ");
}

/** `sets run`: the CLI half. */
export async function setsCommand(sub, options, { write = (t) => process.stdout.write(t) } = {}) {
  if (sub !== "run") throw new Error("usage: sets run [--conversations <file.json>] [--set dev] [--tree <dir>] [--node <id>] [--out <file.json>] [--fake]");
  let convs;
  if (options.conversations) convs = JSON.parse(await readFile(resolve(options.conversations), "utf8"));
  else {
    const { loadSets } = await import("./sets.mjs");
    const set = options.set ?? "dev";
    convs = (await loadSets()).filter((c) => c.set === set);
  }
  if (!Array.isArray(convs)) throw new Error("--conversations is a JSON list of conversations");
  const tree = resolve(options.tree ?? join(import.meta.dirname, "../../.."));
  const rows = await runSets(convs, { tree, node: options.node ?? null, fake: Boolean(options.fake) });
  if (options.out) await writeFile(resolve(options.out), JSON.stringify(rows, null, 1) + "\n");
  write(`${countsLine(rows)}\n`);
  // The repo's sets name what missed (their words are public); a file handed in may be sealed, so it never does.
  if (!options.conversations && !options.out) for (const r of rows.filter((x) => !x.right)) write(`MISS ${r.chat}/${r.msg} ${r.node}: ${r.why ?? ""}\n`);
  return rows;
}
