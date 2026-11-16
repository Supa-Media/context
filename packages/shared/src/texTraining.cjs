/**
 * THE TRAINING SET AS EACH STEP'S EXAMPLES (Dev2, 2026-11-15: Training is "shown to steps as examples", never run in
 * CI; "wire in the fact that we might want to put different training ... the context module to put in the training
 * set").
 *
 * Every label on a Training conversation (`apps/mcp/bench/sets/training/<id>.json`, the contract in `texSets.cjs`) is
 * one example for its node: the chat before the message, the message, and what the node should output on it. A
 * node reads them through a context module in its config (`texConfig.json` `nodes[].ctx`): `train:<nodeId>` is that
 * node's Training labels, so a step reads its own with `train:<its id>`, another step's by naming that one, several
 * in the order listed, and none when the entry is taken out. The module's text is built here, from moments that
 * `scripts/tex-training-module.mjs` writes into `texTraining.generated.json`, because a Worker reads no folder.
 *
 * Lines are written the way the judge reads a chat (`textDecide.cjs` `CHAT_MARKS`): "You" is Tex, a person is
 * `@name`, a reply says whose message it was sent under, a tapback names the message it is on, and Tex's newest
 * question is marked.
 */
"use strict";

const { before } = require("./texSets.cjs");

/** The context entry that names a node's Training labels. */
const TRAIN_ENTRY = /^train:([A-Za-z][A-Za-z0-9]{0,47})$/;

/** A tapback's words, as a phone shows them under the emoji: the first 32 characters. */
const QUOTE_CHARS = 32;

/** What a tapback says as an answer (`apps/agent/src/reactions.ts` `reactionLine`): a like, love or emphasis is a yes. */
const TAPBACK_ANSWER = Object.freeze({ "👍": " (yes)", "❤️": " (yes)", "‼️": " (yes)", "👎": " (no)" });

const handle = (who) => `@${String(who).toLowerCase()}`;

function quote(text) {
  const chars = [...String(text ?? "")];
  return chars.length > QUOTE_CHARS ? `${chars.slice(0, QUOTE_CHARS).join("")}…` : chars.join("");
}

/** One message as a line of the chat, given the messages before it. */
function lineOf(m, earlier) {
  const target = m.to === undefined ? null : earlier.find((x) => x.id === m.to) ?? null;
  const whose = target === null ? "" : target.tex ? "You" : handle(target.who);
  if (m.tex) return `You: ${m.text}`;
  const who = handle(m.who);
  if (m.kind === "react") return `${who}: ${m.text}${TAPBACK_ANSWER[m.text] ?? ""} on ${target?.tex ? "Tex's message" : "the message"} "${quote(target?.text)}"`;
  if (m.kind === "reply") return `${who}: (replying to ${whose}) ${m.text}`;
  if (m.kind === "edit") return `${who}: (edits "${quote(target?.text)}" to) ${m.text}`;
  if (m.kind === "delete") return `${who}: (deleted "${quote(target?.text)}")`;
  return `${who}: ${m.text}`;
}

/**
 * How many messages of history a Training example shows a step: the newest ones before the message, after a line
 * that says how many came before them. Training conversations are long (Dev2, 2026-11-16: "conversations are like
 * 100, 500 different turns"), and every example rides in the step's prompt on every call, so a step sees the recent
 * stretch: Decide's whole state is at most 24,000 characters live chat included (`textDecide.cjs` MAX_STATE), and the
 * front door's setup at most 40,000 (`production.js` MAX_BODY_CHARS). A node run alone on a conversation
 * (`apps/mcp/bench/setsRun.mjs`) still reads all of it.
 */
const HISTORY_LINES = 4;
/** Decide's examples share the judge's 24,000 characters with the live chat, so they keep the newest two. */
const HISTORY_FOR = Object.freeze({ decide: 2 });
const historyLines = (node) => HISTORY_FOR[node] ?? HISTORY_LINES;

/** The chat before message `at`, as lines, Tex's newest text marked when it asks something; older lines summed up. */
function linesBefore(c, at, keep = Infinity) {
  const history = before(c, at);
  const lines = history.map((m, i) => lineOf(m, history.slice(0, i)));
  const newestTex = history.map((m) => Boolean(m.tex)).lastIndexOf(true);
  if (newestTex >= 0 && /\?\s*$/.test(history[newestTex].text ?? "")) lines[newestTex] += "   (your newest question)";
  if (lines.length <= keep) return lines;
  const dropped = lines.length - keep;
  return [`(${dropped} earlier message${dropped === 1 ? "" : "s"})`, ...lines.slice(-keep)];
}

/**
 * Every Training label as a moment, by node: `{ chat, kind, setting?, before, newest, label }`, in file order, then
 * message order. The label is the node's own fields without `star` (a star makes it a unit test, not a different
 * example).
 */
function momentsOf(conversations) {
  const nodes = {};
  for (const c of conversations) {
    if (c.set !== "training") continue;
    (c.msgs || []).forEach((m, at) => {
      if (m.tex) return;
      for (const [node, l] of Object.entries(m.labels || {})) {
        const { star: _star, ...label } = l || {};
        if (Object.keys(label).length === 0) continue;
        const moment = { chat: c.id, kind: c.kind, ...(typeof c.setting === "string" ? { setting: c.setting } : {}), before: linesBefore(c, at, historyLines(node)), newest: lineOf(m, before(c, at)), label };
        (nodes[node] ??= []).push(moment);
      }
    });
  }
  return nodes;
}

/** The nodes whose Training labels a step reads, in its context's order. */
function trainingSources(step) {
  return (step?.ctx ?? []).map((entry) => TRAIN_ENTRY.exec(entry)?.[1]).filter(Boolean);
}

const chatLine = (moment) => (moment.kind === "group" ? `group chat, speak-up ${moment.setting ?? "follow along"}` : "one-to-one chat with Tex");

/** A label as the lines an example ends with: each output field, then the front door's must and never lines. */
function wantLines(label) {
  const out = [];
  for (const [k, v] of Object.entries(label)) {
    if (k === "must" || k === "never" || k === "run" || v === "any") continue;
    out.push(`<${k}>${v}</${k}>`);
  }
  for (const line of label.must ?? []) out.push(`<must>${line}</must>`);
  for (const line of label.never ?? []) out.push(`<never>${line}</never>`);
  if (label.run === "must") out.push("<run>this step must run on it</run>");
  if (label.run === "must not") out.push("<run>this step must not run on it</run>");
  return out;
}

/** One moment as an example, in `<example>` tags: the chat, what came before, the newest message, what is wanted. */
function exampleText(moment) {
  const lines = moment.before.length > 0 ? moment.before.join("\n") : "(nothing before)";
  return `<example>\n<chat>${chatLine(moment)}</chat>\n<before>\n${lines}\n</before>\n<newest>${moment.newest}</newest>\n${wantLines(moment.label).join("\n")}\n</example>`;
}

/** What a step's prompt is told before its Training examples. */
const TRAINING_INTRO =
  'Examples from Tex\'s Training Set. Each shows a chat ("You" is Tex, a person\'s name starts with "@"), the newest message, and what this step should do with it: its output, and for an answer what it must and must never do. Judge new messages the way these are judged.';

/**
 * A step's Training module, as its prompt is given it: the intro and every example of every node it reads, or ""
 * when it reads none or they have no labels yet, so an empty Training Set changes no prompt by a byte.
 */
function trainingText(step, generated) {
  const moments = trainingSources(step).flatMap((source) => generated?.nodes?.[source] ?? []);
  if (moments.length === 0) return "";
  return `${TRAINING_INTRO}\n\n<examples>\n${moments.map(exampleText).join("\n")}\n</examples>`;
}

/** One module's text by its entry (`train:<nodeId>`), as the Lab shows it: that node's examples alone. */
function moduleText(entry, generated) {
  return TRAIN_ENTRY.test(entry) ? trainingText({ ctx: [entry] }, generated) : "";
}

module.exports = { TRAIN_ENTRY, QUOTE_CHARS, HISTORY_LINES, historyLines, TRAINING_INTRO, lineOf, linesBefore, momentsOf, trainingSources, wantLines, exampleText, trainingText, moduleText };
