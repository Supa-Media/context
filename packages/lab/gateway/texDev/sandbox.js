/**
 * `tex_dev` `sandbox`: THE LAB'S TEST CHATS, SHAPED FOR AN AI (Dev2, 2026-11-16: "through the MCP, an AI should be
 * able to send some test messages ... see how things ran ... this was its thinking, this was this node, this is what
 * this node did, the nodes that fire, the nodes that didn't fire ... this step ran too slow, or after it makes a change
 * ... this is getting us a better response, so it's able to just trial and error"; spec
 * https://claude.ai/artifact/Uisi6KJQhizxCAos82TTKN).
 *
 * The same test chats the Lab's live sandbox shows, through the same route (`labSandbox/route.js`), on the
 * connection's own grant. What this file adds is only the shape a model reads well:
 *
 *  - `open` answers the last few rows and the count, never a whole chat;
 *  - `send`, `react`, `edit`, `unsend` and `retry` wait (up to `MAX_WAIT_S`) for the run to finish and answer its
 *    **run card**: Tex's texts, the time to the first one, every step that ran in order with its time and output, the
 *    steps of the graph it ran on that did not run and why (off, a wire's `when` the source's tags did not match, a
 *    source that did not run, a helper never called), the slowest steps, what failed and what it would have changed;
 *  - `step` reads one step whole (input, output, thinking, calls, the prompt) with Replay's own reader over the test
 *    chat's history file, the same code `turn` and `prompt` read a real chat with;
 *  - `again` re-runs a text, after `use` or on a `draft`, and answers both cards and what changed between them;
 *  - `try` sends one text to several drafts side by side; `replay` re-runs a real text on a draft beside what ran in
 *    production.
 *
 * Only what the log shows ran is shown; nothing is estimated (Dev2, 2026-11-14). The rest (`chats`, `sets`, `get`,
 * `back`, `drop`, `reset`) is the route's own answer.
 */

import { cutDeep } from "./probe.js";
import { promptAnswer, turnAnswer } from "./replay.js";

/** The most one call waits for a run, and how often it looks. */
export const MAX_WAIT_S = 50;
export const DEFAULT_WAIT_S = 45;
const POLL_MS = 1_500;
/** Rows `open` and `rows` show unless `last`/`limit` says otherwise, and the most. */
export const ROWS_SHOWN = 10;
const MAX_ROWS_SHOWN = 100;
/** Drafts `try` runs one text on at once. */
export const MAX_TRY = 4;
/** A step's output in a card, cut to this; `step` gives it whole. */
const OUT_CUT = 240;
const TEXT_CUT = 600;
const SANDBOX_ID = /^[0-9a-f]{16}$/;
/** Steps that start a run of their own (a check-in, a routine, Send through Tex, an edit, a move, the night): not "didn't run" for a text. */
const TRIGGERS = new Set(["checkin", "routine", "notify", "edit", "moveChat", "nightly"]);
/** The night's steps and a job's: only ever run from their own trigger. */
const ELSEWHERE = new Set(["dream", "daysum", "housekeep"]);

const parse = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const short = (value, max = OUT_CUT) => {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}… [${text.length} chars; step gives it whole]` : text;
};
const secs = (ms) => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : null);

/** A row as an AI reads a chat: who, the words, and what is on it. */
export function compactRow(row) {
  return {
    id: row.id,
    who: row.who,
    text: short(row.text ?? "", TEXT_CUT),
    ...(row.prod ? { real: true } : {}),
    ...(row.reply ? { replyTo: row.reply } : {}),
    ...(row.kind ? { kind: row.kind, on: row.on } : {}),
    ...(row.emoji ? { emoji: row.emoji } : {}),
    ...(row.quiet ? { quiet: true } : {}),
    ...(row.reactions ? { reactions: row.reactions.map((r) => `${r.who} ${r.emoji}`) } : {}),
    ...(row.unsent ? { unsent: true } : {}),
    ...(row.edited ? { edited: true } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(Array.isArray(row.steps) && row.steps.length && !row.prod ? { steps: row.steps.length } : {}),
  };
}

/** The tags a step's output carries, which a wire's `when` is matched against (`texGraph.cjs`): its `when` and `to`. */
function tagsOf(out) {
  const value = parse(out);
  if (!value || typeof value !== "object") return [];
  const tags = [];
  if (Array.isArray(value.when)) tags.push(...value.when.filter((t) => typeof t === "string"));
  else if (typeof value.when === "string") tags.push(value.when);
  if (typeof value.to === "string") tags.push(value.to);
  return tags;
}

/** A step said it failed inside, though it ran to its end: a tool that failed, an outcome "failed". */
function failedInside(out) {
  const value = parse(out);
  if (!value || typeof value !== "object") return null;
  if (value.failed === true) return "failed: true";
  if (value.outcome === "failed") return "outcome failed";
  if (typeof value.error === "string" && value.error) return value.error.slice(0, 200);
  return null;
}

/**
 * The steps of `graph` that did not run on this text, each with why, from the wires into it and what its sources
 * said: never a guess about code that did not log, only the config and the log side by side.
 */
export function notFiredOf(graph, steps) {
  const ran = new Map();
  for (const step of steps) ran.set(step.node, [...(ran.get(step.node) ?? []), ...tagsOf(step.out)]);
  const label = new Map(graph.nodes.map((n) => [n.id, n.label ?? n.id]));
  const out = [];
  for (const node of graph.nodes) {
    if (ran.has(node.id) || TRIGGERS.has(node.id) || ELSEWHERE.has(node.id)) continue;
    if (node.on === false) {
      out.push({ node: node.id, why: "off in this config" });
      continue;
    }
    const into = graph.edges.filter((e) => e.to === node.id);
    const reasons = [];
    for (const wire of into) {
      const when = Array.isArray(wire.when) && wire.when.length ? wire.when : ["*"];
      if (!ran.has(wire.from)) {
        if (TRIGGERS.has(wire.from) || ELSEWHERE.has(wire.from)) continue;
        reasons.push(`${wire.from} did not run`);
        continue;
      }
      const tags = ran.get(wire.from);
      const matched = when.includes("*") || when.some((w) => tags.includes(w));
      if (wire.mode === "uses") reasons.push(`${wire.from} may call it${when.includes("*") ? "" : ` (when ${when.join(", ")})`} and did not`);
      else if (wire.mode === "job") reasons.push(`${wire.from} started no job`);
      else if (!matched) reasons.push(`${wire.from} said [${tags.join(", ") || "nothing"}], the ${wire.mode} wire wants [${when.join(", ")}]`);
      else reasons.push(`${wire.from} ran and said [${tags.join(", ") || "nothing"}], which the ${wire.mode} wire [${when.join(", ")}] runs it on, but it logged no run: the code did not run it though the config says it does`);
    }
    if (reasons.length === 0) continue;
    out.push({ node: node.id, ...(label.get(node.id) !== node.id ? { label: label.get(node.id) } : {}), why: reasons.join("; ") });
  }
  return out;
}

/** One step as the card lists it. Rich fields (`labSandbox` contract: id, at, model, tokens, cost, calls) when logged. */
function cardStep(step, n) {
  const out = parse(step.out);
  const inside = failedInside(out);
  return {
    n,
    node: step.node,
    ...(typeof step.id === "string" ? { id: step.id } : {}),
    ...(typeof step.parent === "string" ? { parent: step.parent } : {}),
    ...(Number.isFinite(step.at) ? { atMs: step.at } : {}),
    ...(Number.isFinite(step.ms) ? { ms: step.ms } : { running: true }),
    ...(step.ok === false ? { ok: false } : {}),
    ...(inside ? { failedInside: inside } : {}),
    ...(step.bg ? { background: true } : {}),
    ...(step.model ? { model: step.model } : {}),
    ...(step.effort ? { effort: step.effort } : {}),
    ...(Number.isFinite(step.tokIn) ? { tokIn: step.tokIn } : {}),
    ...(Number.isFinite(step.tokOut) ? { tokOut: step.tokOut } : {}),
    ...(Number.isFinite(step.cost) ? { cost: step.cost } : {}),
    ...(Array.isArray(step.calls) && step.calls.length ? { calls: step.calls.map((c) => `${c.tool}${c.kind === "write" ? " (sandbox write)" : ""}${Number.isFinite(c.ms) ? ` ${c.ms} ms` : ""}`) } : {}),
    ...(typeof step.think === "string" && step.think ? { thinking: short(step.think, 160) } : {}),
    out: short(out),
  };
}

/**
 * The run card for one test row: what Tex said, how long it took, every step that ran, every step that did not and
 * why, the slowest, what failed and what it would have changed. `graph` is the config the run ran on.
 */
export function runCard({ rows, msgId, writes = [], graph, running = null, draft = "main", fit = null }) {
  const row = rows.find((r) => r.id === msgId);
  if (!row) return { error: `There is no row ${msgId} in this test chat.` };
  const replies = rows.filter((r) => r.reply === msgId || (r.who === "Tex" && r.on === msgId));
  const reply = replies[0] ?? null;
  const steps = (reply?.steps?.length ? reply.steps : row.steps) ?? [];
  const done = running?.msgId !== msgId && (reply !== null || row.error);
  const said = replies.filter((r) => !r.quiet && typeof r.text === "string" && r.text !== "");
  const first = said[0] ?? null;
  const fired = steps.map((s, i) => cardStep(s, i + 1));
  const failed = fired.filter((s) => s.ok === false || s.failedInside).map((s) => ({ n: s.n, node: s.node, why: s.failedInside ?? "ok: false" }));
  const slowest = fired.filter((s) => Number.isFinite(s.ms) && s.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 3).map((s) => `${s.node} ${secs(s.ms)}`);
  const mine = writes.filter((w) => w && (w.by === undefined || w.by === msgId));
  // Texts a background job sent later for this text (`from: "job"`): the Tex rows after it, before the next test text.
  const at = rows.indexOf(row);
  const nextOwn = rows.findIndex((r, i) => i > at && r.who !== "Tex" && !r.prod);
  const later = rows.slice(at + 1, nextOwn < 0 ? rows.length : nextOwn).filter((r) => r.who === "Tex" && r.from === "job" && !replies.includes(r));
  // Each Tex text with what sent it, the steps that led to it (`cause`, logged, never inferred) and the line's delay.
  const sent = [...said, ...later].filter((r) => r.from || Array.isArray(r.cause) || Number.isFinite(r.line?.outMs));
  return {
    msgId,
    status: done ? "done" : "running",
    ...(done ? {} : { runningNow: running?.node ?? null, next: `wait { sandboxId, msgId: "${msgId}" } for the rest` }),
    draft,
    ...(done && fit && fit.asDrawn === false ? { ranAs: ranAsOf(fit, fired) } : {}),
    sent: { who: row.who, text: short(row.text ?? "", TEXT_CUT), ...(row.kind ? { kind: row.kind, on: row.on } : {}) },
    tex: said.map((r) => short(r.text, 2_000)),
    ...(later.length ? { jobTexts: later.map((r) => ({ id: r.id, text: short(r.text, 2_000), ...(Array.isArray(r.cause) ? { cause: r.cause } : {}) })) } : {}),
    ...(sent.length ? { texSent: sent.map((r) => ({ id: r.id, from: r.from ?? "fd", ...(Array.isArray(r.cause) ? { cause: r.cause } : {}), ...(Number.isFinite(r.line?.outMs) ? { lineOutMs: r.line.outMs } : {}) })) } : {}),
    // An ask of Tex in another chat, carried after this run (`labSandbox/crossRuns.js`): the group's linked test chat and
    // the rows its run and the answer's run came in on, each with its own card.
    ...(Array.isArray(reply?.cross) && reply.cross.length ? { cross: reply.cross.map((c) => ({ ...cutDeep(c, 80), ...(c.ask ? { askCard: `card { sandboxId: "${c.sandboxId}", msgId: "${c.ask}" }` } : {}), ...(c.answer ? { answerCard: `card { msgId: "${c.answer}" } in this test chat` } : {}) })) } : {}),
    ...(reply?.quiet ? { quiet: short(reply.text || "Tex stayed quiet", 300) } : {}),
    ...(row.error || reply?.error ? { error: row.error ?? reply.error } : {}),
    time: {
      ...(Number.isFinite(reply?.ms) ? { totalMs: reply.ms } : {}),
      ...(first && Number.isFinite(first.at) && Number.isFinite(row.at) ? { firstTextMs: first.at - row.at } : {}),
      ...(Number.isFinite(reply?.line?.outMs) || Number.isFinite(row.line?.inMs) ? { lineMs: { in: row.line?.inMs ?? null, out: reply?.line?.outMs ?? null } } : {}),
    },
    slowest,
    failed,
    fired,
    notFired: done ? notFiredOf(graph, steps) : "after it finishes",
    writes: mine.map((w) => (typeof w === "string" ? w : { ...cutDeep(w, 300), ...(w.kind === "page" ? { read: `page { sandboxId, id: "${w.id}" }` } : {}) })),
    drill: `step { sandboxId, msgId: "${msgId}", node } for a step's input, output, thinking and calls; part: "prompt" for its prompt`,
  };
}

/**
 * How a run on a draft that cannot run as drawn really ran (`draftFit`): the steps the draft adds that did not run
 * (no code), the steps it removes that ran anyway, by name from this run's log, and main's wires when its own could
 * not run. Said first on the card, so a run is never read as the draft's when it was main's.
 */
export function ranAsOf(fit, fired) {
  const ran = new Set((fired ?? []).map((s) => s.node));
  const idOf = (entry) => String(entry).split(" ")[0];
  const stillRan = (fit.removed ?? []).filter((entry) => ran.has(idOf(entry)));
  return {
    asDrawn: false,
    says: `Not the draft as drawn: ${fit.says}`,
    ...(fit.noCode ? { notRunNoCode: fit.noCode } : {}),
    ...(stillRan.length ? { removedButRan: stillRan } : {}),
    wires: fit.wires === "main" ? "main's (the draft's name steps with no code)" : "the draft's",
    ...(fit.unapplied ? { ranAsMain: fit.unapplied } : {}),
  };
}

/** What changed between two run cards: Tex's words, the time, steps only in one, and each shared step's time and output. */
export function cardDiff(a, b) {
  if (!a || !b || a.error || b.error) return null;
  const byNode = (card) => {
    const m = new Map();
    for (const s of Array.isArray(card.fired) ? card.fired : []) m.set(s.node, [...(m.get(s.node) ?? []), s]);
    return m;
  };
  const A = byNode(a);
  const B = byNode(b);
  const steps = [];
  for (const node of new Set([...A.keys(), ...B.keys()])) {
    const x = A.get(node) ?? [];
    const y = B.get(node) ?? [];
    const msA = x.reduce((t, s) => t + (s.ms ?? 0), 0);
    const msB = y.reduce((t, s) => t + (s.ms ?? 0), 0);
    const outA = x.map((s) => s.out).join(" | ");
    const outB = y.map((s) => s.out).join(" | ");
    if (x.length === y.length && outA === outB && Math.abs(msA - msB) < 250) continue;
    steps.push({ node, ...(x.length !== y.length ? { runs: `${x.length} → ${y.length}` } : {}), ms: `${msA} → ${msB}`, ...(outA !== outB ? { out: { before: outA, after: outB } } : {}) });
  }
  const same = JSON.stringify(a.tex) === JSON.stringify(b.tex);
  return {
    tex: same ? "same words" : { before: a.tex, after: b.tex },
    totalMs: `${a.time?.totalMs ?? "?"} → ${b.time?.totalMs ?? "?"}`,
    firstTextMs: `${a.time?.firstTextMs ?? "?"} → ${b.time?.firstTextMs ?? "?"}`,
    onlyBefore: [...A.keys()].filter((n) => !B.has(n)),
    onlyAfter: [...B.keys()].filter((n) => !A.has(n)),
    steps,
  };
}

/**
 * The sandbox action. `route(body)` is the Lab's own route on this connection's grant (`{ ok, status, answer }`);
 * `graphOf(versionId)` the config a draft (or main) runs; `page()` the person's Tex page (for Replay's reader);
 * `realTurn(args)` a production turn's card for `replay`.
 */
export function createSandboxActions({ route, graphOf, page, env, origin, realChat = null, by = "AI", sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const fail = (message) => ({ error: message });

  /** Ops the Lab lists as this AI's (`route.js` `list`): who opened a test chat, and who used it last. */
  const SIGNED = new Set(["open", "send", "react", "edit", "unsend", "retry", "use"]);
  const linkOf = (sandboxId, versionId) => `${origin}/lab?sandbox=${sandboxId}${versionId && versionId !== "main" ? `&v=${versionId}` : ""}`;

  async function call(body) {
    const r = await route(SIGNED.has(body?.op) ? { ...body, by } : body);
    return r.ok ? r.answer : fail(typeof r.answer?.error === "string" ? r.answer.error : `The Lab's test chats answered ${r.status}.`);
  }

  async function about(sandboxId) {
    return await call({ op: "about", sandboxId });
  }

  async function cardNow(sandboxId, msgId, info = null) {
    const facts = info ?? (await about(sandboxId));
    if (facts.error) return facts;
    const view = await call({ op: "get", sandboxId });
    if (view.error) return view;
    const given = { rows: view.rows ?? [], msgId, writes: view.writes ?? [], running: view.running, draft: facts.versionId };
    const card = runCard({ ...given, graph: { nodes: [], edges: [] } });
    // The config it ran on is read only once the run is done: it is what the steps that did not run are told from.
    if (card.error || card.status !== "done") return card;
    // A draft the Lab sent as drawn (not saved yet) is read from the test chat itself: the saved copy isn't what ran.
    const drawn = facts.drawn === true ? (await call({ op: "about", sandboxId, graph: true })).graph ?? null : null;
    const graph = await graphOf(facts.versionId, drawn);
    if (graph.error) return graph;
    return runCard({ ...given, graph: graph.graph, fit: graph.fit ?? facts.fit ?? null });
  }

  /** Looks until the run is done or `seconds` pass, then answers its card as it stands. */
  async function waitCard(sandboxId, msgId, seconds) {
    const info = await about(sandboxId);
    if (info.error) return info;
    const until = now() + Math.max(0, Math.min(MAX_WAIT_S, Number.isFinite(seconds) ? seconds : DEFAULT_WAIT_S)) * 1000;
    for (;;) {
      const card = await cardNow(sandboxId, msgId, info);
      if (card.error || card.status === "done" || now() >= until) return card;
      await sleep(POLL_MS);
    }
  }

  const needId = (args) => (typeof args?.sandboxId === "string" && SANDBOX_ID.test(args.sandboxId) ? null : fail("Name the test chat: { sandboxId } from open."));

  /** A row's turn in the test chat's history file: the reply after it, read with the route's `read`. */
  async function turnOfRow(sandboxId, msgId) {
    const view = await call({ op: "get", sandboxId });
    if (view.error) return view;
    const row = (view.rows ?? []).find((r) => r.id === msgId);
    if (!row) return fail(`There is no row ${msgId} in this test chat.`);
    const read = await call({ op: "read", sandboxId, options: { since: row.at, kinds: ["reply"], limit: 20 } });
    if (read.error) return read;
    const reply = (read.entries ?? []).filter((e) => typeof e.turn === "string").sort((a, b) => a.at - b.at)[0];
    return reply ? { turn: reply.turn, at: reply.at } : fail(view.running?.msgId === msgId ? "This text is still running: wait for it first." : "This text ran no turn (a quiet reply has no steps of the turn's own); its card lists the chat object's steps.");
  }

  /** `step`: Replay's own reader (`turn`, or `prompt` with part "prompt") over the test chat's history file. */
  async function step(args) {
    const facts = await about(args.sandboxId);
    if (facts.error) return facts;
    const found = await turnOfRow(args.sandboxId, args.msgId);
    if (found.error) return found;
    const p = await page();
    if (p.error) return { tool: p.error };
    const sandboxLedger = { read: async (_name, options) => {
      const read = await call({ op: "read", sandboxId: args.sandboxId, options });
      return read.error ? { entries: [] } : read;
    } };
    const deps = { ledgerOf: () => sandboxLedger, origin, fetch: (...a) => globalThis.fetch(...a) };
    const chat = facts.kind === "group" ? facts.chat : "me";
    const given = { chat, turn: found.turn, at: found.at, ...(typeof args.node === "string" ? { node: args.node } : {}), ...(args.full === true ? { full: true } : {}), ...(typeof args.detail === "string" ? { detail: args.detail } : {}) };
    if (args.part === "prompt") return await promptAnswer(env, p.page, { ...given, ...(args.round ? { round: args.round } : {}), ...(args.module ? { module: args.module } : {}) }, deps);
    const answer = await turnAnswer(env, p.page, given, deps);
    if (answer.error) return answer;
    // The test chat has no Lab Replay link of its own; its run is read here and in the Lab's sandbox dock.
    const { link: _link, ...rest } = answer;
    if (typeof args.node !== "string") return { sandboxId: args.sandboxId, msgId: args.msgId, ...rest };
    // One step asked for: its own entries, not the whole turn's (a model reading one step needs only that step).
    const own = (e) => e.name === args.node || (args.node === "fd" && (e.kind === "thinking" || e.kind === "tool" || e.kind === "judge"));
    const { timing: _t, ...summary } = rest.summary ?? {};
    return {
      sandboxId: args.sandboxId,
      msgId: args.msgId,
      turn: rest.turn,
      node: args.node,
      real: rest.real ? { waitedMs: rest.real.waitedMs, nodes: rest.real.nodes.filter((n) => n.node === args.node) } : null,
      io: rest.io,
      order: (rest.order ?? []).filter(own),
      summary: { ms: summary.ms, model: summary.model, version: summary.version, failed: (summary.failed ?? []).filter((f) => String(f.what).includes(args.node)) },
      ...(args.node === "fd" ? { prompt: rest.prompt } : {}),
      more: "step without node gives the whole turn in order",
    };
  }

  /** `open`: a test chat, answered with its last rows only. */
  async function open(args) {
    const { last, ...body } = args;
    const opened = await call({ ...body, op: "open", ...(typeof args.draft === "string" ? { versionId: args.draft } : {}) });
    if (opened.error) return opened;
    const shown = Number.isSafeInteger(last) && last >= 0 ? Math.min(last, MAX_ROWS_SHOWN) : ROWS_SHOWN;
    const rows = opened.rows ?? [];
    return {
      sandboxId: opened.sandboxId,
      draft: body.versionId ?? args.draft ?? "main",
      people: opened.people,
      total: rows.length,
      last: rows.slice(rows.length - shown).map(compactRow),
      ...(opened.fit?.asDrawn === false ? { fit: opened.fit } : {}),
      link: linkOf(opened.sandboxId, body.versionId ?? args.draft),
      watch: "the person sees this test chat live in the Lab at link (its texts playing as they run, the draft's edits as you make them)",
      next: "send { sandboxId, text } runs a text and answers its run card; rows { sandboxId, before } pages back",
    };
  }

  async function rows(args) {
    const view = await call({ op: "get", sandboxId: args.sandboxId });
    if (view.error) return view;
    const list = view.rows ?? [];
    const end = typeof args.before === "string" ? Math.max(0, list.findIndex((r) => r.id === args.before)) : list.length;
    const shown = Number.isSafeInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_ROWS_SHOWN) : ROWS_SHOWN * 2;
    const start = typeof args.after === "string" ? list.findIndex((r) => r.id === args.after) + 1 : Math.max(0, end - shown);
    const page = list.slice(start, typeof args.after === "string" ? start + shown : end);
    return { total: list.length, rows: page.map(compactRow), running: view.running ? { msgId: view.running.msgId, node: view.running.node } : null, ...(start > 0 && page.length ? { before: page[0].id } : {}) };
  }

  /** A route op that starts a run (`send`, `react`, `edit`, `unsend`, `retry`), then its card. */
  async function runAndWait(op, args) {
    const { wait, ...body } = args;
    const started = await call({ ...body, op });
    if (started.error) return started;
    if (wait === 0 || wait === false) return { msgId: started.msgId, status: "running", next: `wait { sandboxId, msgId: "${started.msgId}" } or card` };
    return await waitCard(args.sandboxId, started.msgId, typeof wait === "number" ? wait : DEFAULT_WAIT_S);
  }

  /** `again`: the same text re-run (on `draft`, when given), both cards and what changed. */
  async function again(args) {
    const before = await cardNow(args.sandboxId, args.msgId);
    if (before.error) return before;
    if (before.status !== "done") return fail("That text is still running: wait for it first.");
    if (typeof args.draft === "string") {
      const used = await call({ op: "use", sandboxId: args.sandboxId, versionId: args.draft });
      if (used.error) return used;
    }
    const after = await runAndWait("retry", { sandboxId: args.sandboxId, msgId: args.msgId, wait: args.wait });
    if (after.error) return after;
    return { before: brief(before), after, diff: after.status === "done" ? cardDiff(before, after) : "after it finishes" };
  }

  /** `try`: one text on several drafts, each in its own test chat opened the same way, side by side. */
  async function tryDrafts(args) {
    const drafts = Array.isArray(args.drafts) && args.drafts.length ? args.drafts.slice(0, MAX_TRY) : ["main"];
    if (typeof args.text !== "string" || args.text.trim() === "") return fail("try takes { text, drafts: [\"main\", \"v…\"], source, chatId?, convId?, base? }");
    const openBody = { source: args.source ?? "maya", ...(args.chatId ? { chatId: args.chatId } : {}), ...(args.convId ? { convId: args.convId } : {}), ...(args.base ? { base: args.base } : {}) };
    const runs = await Promise.all(drafts.map(async (draft) => {
      const opened = await call({ ...openBody, op: "open", versionId: draft });
      if (opened.error) return { draft, error: opened.error };
      const card = await runAndWait("send", { sandboxId: opened.sandboxId, text: args.text, ...(args.as ? { as: args.as } : {}), wait: args.wait });
      return { draft, sandboxId: opened.sandboxId, card };
    }));
    const base = runs[0]?.card;
    return { text: args.text, runs: runs.map((r, i) => ({ ...r, ...(i > 0 && r.card ? { vsFirst: cardDiff(base, r.card) } : {}) })) };
  }

  /**
   * `replay`: a real text re-run on a draft (or main), beside what ran in production: the test chat opens on the real
   * chat just before it (`base`), the same words are sent as the same person, and the diff is against the production
   * turn's own logged steps.
   */
  async function replay(args) {
    if (typeof realChat !== "function") return fail("replay is not available here");
    if (typeof args.text !== "string" || args.text === "") return fail("replay takes { chat?, text: <a real text's id from moments, mine or entries (its eid)>, draft? }");
    const chat = typeof args.chat === "string" && args.chat !== "" ? args.chat : "me";
    const real = await realChat(chat);
    if (real.error) return real;
    const prod = await prodRun(real, args.text);
    if (prod.error) return prod;
    const opened = await call({ op: "open", source: "chat", chatId: chat, base: args.text, ...(typeof args.draft === "string" ? { versionId: args.draft } : {}) });
    if (opened.error) return opened;
    const as = prod.row.who === "You" ? undefined : prod.from;
    // The test chat holds the real rows under their own ids, so a reply goes under the same message it went under.
    const replyTo = prod.row.replyTo;
    const card = await runAndWait("send", { sandboxId: opened.sandboxId, text: prod.row.text, ...(as ? { as } : {}), ...(replyTo ? { replyTo } : {}), wait: args.wait });
    const notes = [...(prod.pics ? ["its pictures are not sent again"] : []), ...(prod.tapback ? ["a tapback: its log keeps only its words, so it is sent again as a text"] : [])];
    return {
      text: { id: args.text, who: prod.row.who, words: short(prod.row.text, TEXT_CUT), ...(replyTo ? { replyTo } : {}), ...(notes.length ? { note: notes.join("; ") } : {}) },
      production: prod.card,
      sandboxId: opened.sandboxId,
      now: card,
      diff: card.status === "done" ? cardDiff(prod.card, card) : "after it finishes",
    };
  }

  return async function sandbox(args = {}) {
    const op = args.op;
    switch (op) {
      case "open":
        return await open(args);
      case "rows":
        return needId(args) ?? (await rows(args));
      case "send":
      case "react":
      case "edit":
      case "unsend":
      case "retry":
        return needId(args) ?? (await runAndWait(op, args));
      case "wait":
        return needId(args) ?? (await waitCard(args.sandboxId, args.msgId, args.seconds ?? DEFAULT_WAIT_S));
      case "card":
        return needId(args) ?? (await cardNow(args.sandboxId, args.msgId));
      case "step":
        return needId(args) ?? (await step(args));
      case "again":
        return needId(args) ?? (await again(args));
      case "use":
        return needId(args) ?? (await call({ op: "use", sandboxId: args.sandboxId, versionId: args.draft ?? args.versionId ?? "main" }));
      case "about": {
        if (needId(args)) return needId(args);
        const facts = await about(args.sandboxId);
        return facts.error ? facts : { ...facts, link: linkOf(args.sandboxId, facts.versionId) };
      }
      case "link":
        return needId(args) ?? { link: linkOf(args.sandboxId, args.draft) };
      case "list": {
        const listed = await call({ op: "list" });
        return listed.error ? listed : { chats: (listed.chats ?? []).map((c) => ({ ...c, link: linkOf(c.sandboxId, c.versionId) })) };
      }
      case "try":
        return await tryDrafts(args);
      case "replay":
        return await replay(args);
      default:
        // The route's own: chats, sets, get, back, drop, reset.
        return await call(args);
    }
  };
}

/** Worker steps a production turn's text went through before the turn, as the Lab's rows name them (`chatRun.js`). */
const WORKER_STEP_NODE = { text: "text", oldLine: "oldLine", triage: "triage", decide: "decide", recheck: "decide", lane: "lanes", react: "react", send: "send", edit: "edit" };

/**
 * What ran in production for one real text: its turn (the first reply after it) and that turn's logged steps, with
 * the Worker's own steps between the text and the reply. Only what the log shows; the steps that did not run are not
 * worked out, because the graph it ran on was the one of its version, not today's.
 */
export async function prodRun({ ledger, name }, eid) {
  const texts = await ledger.read(name, { before: Number.MAX_SAFE_INTEGER, kinds: ["text"], limit: 5_000, jobs: false });
  const text = (texts.entries ?? []).find((e) => e.eid === eid && e.from?.kind !== "tex");
  if (!text) return { error: `There is no text ${eid} from a person in this chat's recent history; moments, mine or entries give the ids.` };
  const span = await ledger.read(name, { since: text.at, until: text.at + 15 * 60_000, limit: 5_000 });
  const entries = (span.entries ?? []).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));
  const reply = entries.find((e) => e.kind === "reply" && typeof e.turn === "string" && e.at > text.at);
  if (!reply) return { error: `No turn was logged after text ${eid}.` };
  // A Worker step is logged as `step: "<name>"` or `step: { name, output, ms, ok }` (`stepEvents.ts`); both read the same.
  const worker = (e) => (typeof e.step === "string" ? { name: e.step, output: e.output, ms: e.ms, ok: e.ok } : e.step && typeof e.step === "object" ? e.step : null);
  const steps = [];
  for (const e of entries) {
    if (e.kind !== "step") continue;
    if (e.step === "node") {
      if (e.turn === reply.turn && typeof e.name === "string") steps.push({ node: e.name, out: e.output ?? null, ms: Number.isFinite(e.ms) ? e.ms : 0, ok: e.ok !== false });
      continue;
    }
    const w = worker(e);
    if (w && WORKER_STEP_NODE[w.name] && !e.turn && e.at <= reply.at) steps.push({ node: WORKER_STEP_NODE[w.name], out: w.output ?? null, ms: Number.isFinite(w.ms) ? w.ms : 0, ok: w.ok !== false });
  }
  const said = entries.filter((e) => e.kind === "text" && e.turn === reply.turn && e.from?.kind === "tex");
  const who = text.from?.name ? String(text.from.name) : "You";
  // A reply keeps the text it was sent under, so its replay is threaded the same way (Decide reads "(replying to You)").
  const row = { id: eid, who, text: String(text.text ?? ""), at: text.at, prod: true, ...(typeof text.replyTo === "string" && text.replyTo !== "" ? { replyTo: text.replyTo } : {}) };
  const rows = [row, ...(said.length ? said : [{ text: reply.text ?? "", at: reply.at }]).map((t, i) => ({ id: `${eid}r${i}`, reply: eid, who: "Tex", text: String(t.text ?? ""), at: t.at, ms: reply.ms, ...(i === 0 ? { steps } : {}) }))];
  const card = runCard({ rows, msgId: eid, graph: { nodes: [], edges: [] }, draft: "production" });
  return {
    row,
    from: text.from?.name ?? null,
    pics: Array.isArray(text.attachments) && text.attachments.length > 0,
    tapback: text.event === "reaction",
    card: { ...card, turn: reply.turn, ...(reply.version ? { version: reply.version } : {}), notFired: "not worked out for a production run: it ran on its own version's graph", drill: `turn { chat, turn: "${reply.turn}" } reads it whole` },
  };
}

/** A card without its step lists, for the "before" of `again`. */
function brief(card) {
  const { fired, notFired: _n, drill: _d, ...rest } = card;
  return { ...rest, steps: Array.isArray(fired) ? fired.map((s) => `${s.node} ${s.ms ?? "?"} ms`) : [] };
}
