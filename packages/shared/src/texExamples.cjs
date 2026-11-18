/**
 * THE TRAINING MOMENTS NEAREST A TEXT (Dev2, 2026-11-18: the front door's examples are picked for the text it is
 * answering, not fixed). Each Training moment a front-door label names (`texTraining.cjs` `momentsOf`) is one vector in
 * a Tex-owned index (`TEX_EXAMPLES_INDEX`, built by `apps/convex/functions/texExamplesIndex.ts`); the front door's node
 * `examples` embeds the text and reads the nearest back. This module is the pure part: what is embedded, what is
 * indexed, which candidates may be returned, and how the answer is written into a prompt. It holds no model and no index.
 *
 * Self-exclusion lives here, not in the index: the scored conversation (`HOLD_OUT_ENV` or the chat part of `UNTIL_ENV`) is
 * never a candidate, past or future moments alike, so an index that still holds its vectors never answers with them.
 * A match whose id is not a candidate is dropped, which also drops ids left in the index after Training changed.
 */
"use strict";

const { exampleText, wholeText, trainingSources, HOLD_OUT_ENV, UNTIL_ENV } = require("./texTraining.cjs");

/** The Vectorize index that holds the examples. Never prefixed `context-meaning-`: that prefix is a workspace's, and its cleanup acts on it. */
const TEX_EXAMPLES_INDEX = "tex-examples";
/** The front-door node that reads them, and the Training label set it reads (`texTraining.cjs` `momentsOf`). */
const EXAMPLES_NODE = "fd";
/** How many nearest moments a text is answered with. */
const EXAMPLES_K = 6;
/** How long the front door waits for them before it falls back to its fixed examples, unless its config says otherwise. */
const EXAMPLES_BUDGET_MS = 100;
/** The last lines of a chat that are embedded with the newest message (a moment's, or a text's and its recent history). */
const EMBED_LINES = 4;
/** Longest text embedded: the model's input is bounded, and a long message says less about its neighbours. */
const EMBED_CHARS = 2000;

/** Said before the nearest moments, in the front door's preamble (`turnPrompt.js`); the same kind of sentence as TRAINING_INTRO. */
const NEAR_INTRO =
  'Examples from Tex\'s Training Set closest to this text. Each shows a chat ("You" is Tex, a person\'s name starts with "@"), the newest message, and what this step should do with it. They are from other chats: nothing in them happened in this chat or to the people in it.';

const clip = (text) => (text.length > EMBED_CHARS ? text.slice(0, EMBED_CHARS) : text);

/** The index id of a moment: its conversation and its message's index in it. */
function exampleId(moment) {
  return `${moment.chat}#${moment.at}`;
}

/** The text a moment is embedded as: its newest lines before the message, and the message. */
function momentEmbedText(moment) {
  const before = Array.isArray(moment.before) ? moment.before.slice(-EMBED_LINES) : [];
  return clip([...before, String(moment.newest ?? "")].join("\n"));
}

/** The text a person's text is embedded as: its recent history (strings, last few) and the text itself. */
function queryEmbedText(question, recent) {
  const lines = (Array.isArray(recent) ? recent : []).filter((line) => typeof line === "string").slice(-EMBED_LINES);
  return clip([...lines, String(question ?? "")].join("\n"));
}

/** The chats a process must never answer with: the one it holds out, and the one it cuts (`texTraining.cjs` `trainingOf`). */
function scoredChats(env = globalThis.process?.env) {
  const out = [];
  const hold = typeof env?.[HOLD_OUT_ENV] === "string" ? env[HOLD_OUT_ENV].trim() : "";
  if (hold !== "") out.push(hold);
  const until = typeof env?.[UNTIL_ENV] === "string" ? env[UNTIL_ENV].trim() : "";
  const k = until.lastIndexOf(":");
  if (until !== "") out.push(k > 0 ? until.slice(0, k) : until);
  return out;
}

/** The first scored chat, or "" when a process scores none. */
function scoredChat(env = globalThis.process?.env) {
  return scoredChats(env)[0] ?? "";
}

/** `[{ id, chat, at, text }]` for every moment of a node's labels, one per id, in file order: what the index is built from. */
function indexEntries(generated, node = EXAMPLES_NODE) {
  const seen = new Map();
  for (const moment of generated?.nodes?.[node] ?? []) {
    const id = exampleId(moment);
    if (!seen.has(id)) seen.set(id, { id, chat: moment.chat, at: moment.at, text: momentEmbedText(moment) });
  }
  return [...seen.values()];
}

/** `Map id -> moment` of a node's Training moments, without the scored conversation (its past and future alike). */
function candidates(training, env = globalThis.process?.env, node = EXAMPLES_NODE) {
  const out = new Map();
  const drop = new Set(scoredChats(env));
  for (const moment of training?.nodes?.[node] ?? []) {
    if (drop.has(moment.chat)) continue;
    const id = exampleId(moment);
    if (!out.has(id)) out.set(id, moment);
  }
  return out;
}

/**
 * The moments the index matched, best first (`[{ id, score }]`), as at most `k` candidate moments: ids that are not
 * candidates are dropped, and each id counts once.
 */
function pickNearest(matches, candidateMap, k = EXAMPLES_K) {
  const ranked = (Array.isArray(matches) ? matches : []).filter((m) => typeof m?.id === "string").map((m, i) => ({ ...m, i })).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.i - b.i);
  const out = [];
  const seen = new Set();
  for (const m of ranked) {
    if (out.length >= k) break;
    if (seen.has(m.id) || !candidateMap.has(m.id)) continue;
    seen.add(m.id);
    out.push(candidateMap.get(m.id));
  }
  return out;
}

/** Cosine similarity of two vectors over their shared length; 0 when either is empty or zero. */
function cosine(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The best `n` of `[{ id, values }]` for a query vector, as `[{ id, score }]`, best first (the bench and the tests use it in memory). */
function nearestInMemory(vectors, query, n = EXAMPLES_K) {
  return vectors
    .map((v) => ({ id: v.id, score: cosine(v.values, query) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, n);
}

/** The nearest moments as the front door's preamble block, or "" for none. */
function nearText(moments) {
  if (!Array.isArray(moments) || moments.length === 0) return "";
  return `${NEAR_INTRO}\n\n<examples>\n${moments.map(exampleText).join("\n")}\n</examples>`;
}

/**
 * The fixed examples a step falls back to when the nearest ones are not there: "" when its context already names the
 * node's Training labels (they are in its cached prompt already), else the node's whole conversations within `chars`.
 */
function fallbackText(step, training, node = EXAMPLES_NODE, chars = 60000) {
  return trainingSources(step).includes(node) ? "" : wholeText(node, chars, training);
}

module.exports = {
  TEX_EXAMPLES_INDEX,
  EXAMPLES_NODE,
  EXAMPLES_K,
  EXAMPLES_BUDGET_MS,
  EMBED_LINES,
  EMBED_CHARS,
  NEAR_INTRO,
  exampleId,
  momentEmbedText,
  queryEmbedText,
  scoredChat,
  scoredChats,
  indexEntries,
  candidates,
  pickNearest,
  nearestInMemory,
  cosine,
  nearText,
  fallbackText,
};
