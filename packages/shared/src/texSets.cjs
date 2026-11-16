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
 */
"use strict";

const SETS = Object.freeze(["training", "dev", "test"]);
/** The split Dev2 enforces, as a ratio of unit tests (starred labels), never a count. */
const TARGET = Object.freeze({ training: 60, dev: 20, test: 20 });
/** How far a set may drift from its share, in points, before the ratio fails. */
const DRIFT = 10;
const KINDS = Object.freeze(["react", "reply", "edit", "delete"]);
const RUN = Object.freeze(["must", "must not"]);
const TEX = "Tex";
/** A label's keys that are not a node's output fields. */
const LABEL_KEYS = Object.freeze(["star", "run", "must", "never"]);
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * The fields a node is labelled with, from its config `outSchema`: a required choice or yes/no field becomes a
 * pick (with "any"), any other required field free text. Two nodes report the whole turn rather than a verdict, so
 * they are labelled by what matters in it: the front door by must / never lines about its draft, the reply reviewer
 * by how often it sent the draft back. `why` on Decide is the judge's own list of reasons.
 */
function labelFields(node, opts = {}) {
  if (!node) return { picks: {}, texts: [], lines: false };
  if (node.id === "fd") return { picks: {}, texts: [], lines: true };
  if (node.id === "reviewer") return { picks: { sentBack: ["0", "1", "2+"] }, texts: [], lines: false };
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
  const seen = new Set();
  (Array.isArray(c.msgs) ? c.msgs : []).forEach((m, i) => {
    const at = `message ${i + 1}`;
    if (!m || typeof m !== "object") return out.push(`${at} is not a message`);
    if (!m.id || seen.has(m.id)) out.push(`${at} needs an id of its own`);
    if (m.tex) {
      if (m.who !== TEX) out.push(`${at} is a Tex row, so its speaker is Tex`);
      if (m.labels && Object.keys(m.labels).length) out.push(`${at} is a Tex row: labels go on people's messages`);
      if (m.star) out.push(`${at} is a Tex row: a whole reply is every node together, never a unit test`);
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

module.exports = { SETS, TARGET, DRIFT, KINDS, RUN, TEX, LABEL_KEYS, labelFields, check, unitTests, before, ratio };
