/**
 * Tex's test sets as conversations (Dev2, 2026-11-15: "we need a way to add some sample or test conversations, and
 * every Tex response in the same conversation is a datapoint along with the conversation history"; "unit tests
 * should be marked per message, per node"; "60/20/20 ... it's just a ratio i want to enforce"; "Training Set, Dev
 * Set, Test Set"). The Lab's Testing tab, the store, the eval service and the prompts' examples all read this one
 * contract, so a conversation means the same thing everywhere.
 *
 * A conversation: `{ id, title, set, kind: "one" | "group", members, msgs }`. A message: `{ id, who, text }`, a Tex
 * row `tex: true` (what Tex should have said, history for later rows, never a test), a special message `kind`
 * (react | reply | edit | delete) pointing at an earlier one by `to`, and `pics` the pictures sent with it
 * (`[{ url, type?, name? }]`; a message with pictures needs no words). A person's message with no Tex row after it is
 * Tex staying quiet: there is no "quiet" row. `labels[nodeId]` is what that node should output on that message:
 * its config output fields (`"any"` skips one), `must` / `never` lines, `run: "must" | "must not"`, and `star: true`
 * when it is a unit test. `rec[nodeId]` is a node's recorded run on main, the frozen input for the nodes it feeds.
 *
 * A turn nobody texted (Dev2, 2026-11-16: Tex's unprompted heads-ups belong in the sets "as routine-fired turns") is
 * a trigger row: `via` names the input that fired it (checkin | routine | notify), `who` is that input's name
 * (TRIGGERS), and `text` says what it brought in (the email, the event, the routine's ask, a background job's report,
 * with the job's `state`). It is not a member, and
 * it carries labels like a person's message, so "should Tex speak up about this" is a unit test. `at` is an
 * optional time line ("Tue 9:20") so long conversations keep their gaps.
 */
"use strict";

const SETS = Object.freeze(["training", "dev", "test"]);
/** The split Dev2 enforces, as a ratio of unit tests (starred labels), never a count. */
const TARGET = Object.freeze({ training: 60, dev: 20, test: 20 });
/** How far a set may drift from its share, in points, before the ratio fails. */
const DRIFT = 10;
const KINDS = Object.freeze(["react", "reply", "edit", "delete"]);
/** The inputs that start a turn with no text, and the name their rows go by. */
const TRIGGERS = Object.freeze({ checkin: "Check-in", routine: "Routine", notify: "Send through Tex", job: "Background job" });
/**
 * A job row's `state`, as the texting Worker reports a job to the chat's turn (`apps/agent/src/jobTexts.ts`): its
 * result (done), an update on its way (running), or its end otherwise. Absent is done.
 */
const JOB_STATES = Object.freeze(["done", "running", "failed", "waiting", "stuck"]);
const RUN = Object.freeze(["must", "must not"]);
const TEX = "Tex";
/** A label's keys that are not a node's output fields. */
const LABEL_KEYS = Object.freeze(["star", "run", "must", "never"]);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
/**
 * The people a Dev conversation may have (Dev2, 2026-11-17: "why dont we use existing people that we do have worlds
 * for then, and then why dont we restrict the people that can be put in these test sets"). A Dev test runs as a real
 * turn in the bench's invented world for its person (`apps/mcp/bench/setsFd.mjs`), so a chat with anyone else can't
 * run. Exactly the people in `apps/mcp/bench/ai/workspaces/people.md`; `setsFd.test.mjs` fails when they part.
 */
const BENCH_PEOPLE = Object.freeze(["Maya", "John", "Priya", "Tomas", "Nia", "Kofi"]);

/**
 * The fields a node is labelled with, from its config `outSchema`: a required choice or yes/no field becomes a
 * pick (with "any"), any other required field free text. Two nodes report the whole turn rather than a verdict, so
 * they are labelled by what matters in it: the front door by must / never lines about its draft, the reply reviewer
 * by how often it sent the draft back. The Job advisor is labelled as its check: verdict, advice and thinking. `why` on Decide is the judge's own list of reasons.
 */
function labelFields(node, opts = {}) {
  if (!node) return { picks: {}, texts: [], lines: false };
  if (node.id === "fd") return { picks: {}, texts: [], lines: true };
  if (node.id === "reviewer") return { picks: { sentBack: ["0", "1", "2+"] }, texts: [], lines: false };
  // The Job advisor's fields are optional because it has two roles (check and mail): its check is labelled by them.
  if (node.id === "jobadv") return { picks: { verdict: ["done", "keep_going", "waiting", "stuck", "none"] }, texts: ["advice", "thinking"], lines: false };
  const picks = {};
  const texts = [];
  for (const f of node.outSchema || []) {
    if (f.optional) continue;
    if (node.id === "decide" && f.name === "why" && opts.why) picks.why = [...opts.why];
    else if (f.type === "choice" && String(f.options || "").includes(",")) picks[f.name] = String(f.options).split(",").map((s) => s.trim());
    else if (f.type === "yesno") picks[f.name] = ["yes", "no"];
    else texts.push(f.name);
  }
  return { picks, texts, lines: false };
}

const nodeOf = (config, id) => (config.nodes || []).find((n) => n.id === id);

/** Every problem with a conversation, as sentences; empty when it is sound. */
function check(c, config, opts = {}) {
  const out = [];
  if (!c || typeof c !== "object") return ["not a conversation"];
  if (!ID.test(String(c.id || ""))) out.push(`id "${c.id}" must be lowercase letters, digits and dashes`);
  if (!SETS.includes(c.set)) out.push(`set "${c.set}" must be one of ${SETS.join(", ")}`);
  if (c.kind !== "one" && c.kind !== "group") out.push(`kind "${c.kind}" must be one or group`);
  const members = Array.isArray(c.members) ? c.members : [];
  if (!members.length) out.push("needs at least one member");
  if (members.includes(TEX)) out.push("Tex is never a member; Tex rows say tex: true");
  if (c.set === "dev" && opts.bench !== false) {
    for (const name of members) {
      if (name !== TEX && !BENCH_PEOPLE.includes(name)) out.push(`${name} has no bench world: a Dev chat's people are the bench's (${BENCH_PEOPLE.join(", ")})`);
    }
  }
  const seen = new Set();
  (Array.isArray(c.msgs) ? c.msgs : []).forEach((m, i) => {
    const at = `message ${i + 1}`;
    if (!m || typeof m !== "object") return out.push(`${at} is not a message`);
    if (!m.id || seen.has(m.id)) out.push(`${at} needs an id of its own`);
    if (m.tex) {
      if (m.who !== TEX) out.push(`${at} is a Tex row, so its speaker is Tex`);
      if (m.labels && Object.keys(m.labels).length) out.push(`${at} is a Tex row: labels go on people's messages`);
      if (m.star) out.push(`${at} is a Tex row: a whole reply is every node together, never a unit test`);
    } else if (m.via !== undefined) {
      if (!TRIGGERS[m.via]) out.push(`${at}: via "${m.via}" must be one of ${Object.keys(TRIGGERS).join(", ")}`);
      else if (m.who !== TRIGGERS[m.via]) out.push(`${at} is fired by ${m.via}, so its speaker is ${TRIGGERS[m.via]}`);
      if (m.kind !== undefined) out.push(`${at} is a trigger, not a ${m.kind}`);
      if (m.state !== undefined && (m.via !== "job" || !JOB_STATES.includes(m.state))) out.push(`${at}: state is a job row's, one of ${JOB_STATES.join(", ")}`);
    } else if (!members.includes(m.who)) out.push(`${at}: ${m.who} is not in the chat's members`);
    if (m.kind !== undefined) {
      if (!KINDS.includes(m.kind)) out.push(`${at}: kind "${m.kind}" must be one of ${KINDS.join(", ")}`);
      else if (!seen.has(m.to)) out.push(`${at} is a ${m.kind} of a message that isn't earlier in the chat`);
    } else if (m.to !== undefined) out.push(`${at} points at another message but has no kind`);
    const hasPics = Array.isArray(m.pics) && m.pics.length > 0;
    if (m.pics !== undefined && !hasPics) out.push(`${at}: pics is a list of pictures`);
    if (!m.tex && m.kind !== "delete" && !String(m.text ?? "").trim() && !hasPics) out.push(`${at} has no words`);
    for (const [nodeId, l] of Object.entries(m.labels || {})) {
      const n = nodeOf(config, nodeId);
      if (!n) { out.push(`${at}: no node "${nodeId}" in Tex's config`); continue; }
      const f = labelFields(n, opts);
      for (const [k, v] of Object.entries(l || {})) {
        if (k === "star") { if (v !== true) out.push(`${at} ${nodeId}: star is true or absent`); }
        else if (k === "run") { if (!RUN.includes(v)) out.push(`${at} ${nodeId}: run is "must" or "must not"`); }
        else if (k === "must" || k === "never") {
          if (!f.lines) out.push(`${at} ${nodeId}: ${k} lines are for the front door`);
          else if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim())) out.push(`${at} ${nodeId}: ${k} is a list of lines`);
        } else if (f.picks[k]) { if (v !== "any" && !f.picks[k].includes(v)) out.push(`${at} ${nodeId}: ${k} "${v}" must be one of ${f.picks[k].join(", ")} or any`); }
        else if (f.texts.includes(k)) { if (typeof v !== "string") out.push(`${at} ${nodeId}: ${k} is text`); }
        else out.push(`${at} ${nodeId}: "${k}" is not one of its output fields`);
      }
    }
    for (const nodeId of Object.keys(m.rec || {})) if (!nodeOf(config, nodeId)) out.push(`${at}: recorded run of unknown node "${nodeId}"`);
    seen.add(m.id);
  });
  return out;
}

/** Every unit test in a conversation: one starred label, one message × one node. */
function unitTests(c) {
  const out = [];
  (c.msgs || []).forEach((m, i) => {
    if (m.tex) return;
    for (const [node, l] of Object.entries(m.labels || {})) if (l && l.star) out.push({ chat: c.id, msg: m.id, at: i, node });
  });
  return out;
}

/** The messages a node sees before message `at`: the history it is given, in order. */
const before = (c, at) => (c.msgs || []).slice(0, at);

/**
 * The split over unit tests: `counts` per set, each set's share in whole points, and whether every set is within
 * DRIFT points of its target. Pass conversations, or counts per set when a set's words are sealed (the Test Set's
 * count comes from the eval service, never its conversations).
 */
function ratio(input) {
  const counts = { training: 0, dev: 0, test: 0 };
  if (Array.isArray(input)) for (const c of input) { if (SETS.includes(c.set)) counts[c.set] += unitTests(c).length; }
  else for (const s of SETS) counts[s] = Number(input?.[s]) || 0;
  const total = SETS.reduce((a, s) => a + counts[s], 0);
  const pct = Object.fromEntries(SETS.map((s) => [s, total ? Math.round((counts[s] * 100) / total) : 0]));
  const off = total ? SETS.filter((s) => Math.abs(pct[s] - TARGET[s]) > DRIFT) : [];
  return { counts, total, pct, holds: total > 0 && off.length === 0, off };
}


/**
 * The scopes with no unit test in the Test Set (Dev2, 2026-11-17: "one pooled 60/20/20 split across all scopes, not a
 * separate split per scope. The only per-scope piece is the non-blocking warning when a scope has no Test cases").
 * A scope is whatever a label is keyed by: a node today, a config group once group labels arrive. `testByScope` is the
 * eval service's public `byNode` count; when it is unknown (null), nothing is named, because a guess would cry wolf.
 * Each entry names the scope and its Training and Dev unit tests. A warning only: nothing fails on it.
 */
function missingTest(convs, testByScope) {
  if (!testByScope || typeof testByScope !== "object") return [];
  const by = {};
  for (const c of convs || []) {
    if (c.set !== "training" && c.set !== "dev") continue;
    for (const t of unitTests(c)) {
      by[t.node] ??= { scope: t.node, training: 0, dev: 0 };
      by[t.node][c.set] += 1;
    }
  }
  return Object.values(by)
    .filter((s) => !(Number(testByScope[s.scope]) > 0))
    .sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
}

module.exports = { SETS, TARGET, DRIFT, KINDS, TRIGGERS, JOB_STATES, RUN, TEX, LABEL_KEYS, BENCH_PEOPLE, labelFields, check, unitTests, before, ratio, missingTest };
