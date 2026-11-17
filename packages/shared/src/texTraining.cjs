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

/**
 * The context entry that names a node's Training labels: `train:<nodeId>` shows each label as a short example (the
 * newest few messages before it), `train:<nodeId>:all:<chars>` shows every Training conversation that node has a label
 * in, whole, with its labels under the messages they are on, as many as fit in `<chars>` characters (Dev2,
 * 2026-11-17: "would it be better to add the entire conversation instead?", chose whole chats, capped in config).
 */
const TRAIN_ENTRY = /^train:([A-Za-z][A-Za-z0-9]{0,47})(?::all:([1-9]\d{0,6}))?$/;

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
  if (m.tex && m.kind === "react") return `You: ${m.text} on ${target?.tex ? "your message" : "the message"} "${quote(target?.text)}"`;
  if (m.tex) return `You: ${m.text}`;
  // A turn nobody texted (`texSets.cjs` trigger rows): what the check-in, routine or send brought in.
  if (m.via !== undefined) return `(${m.who}, nobody texted: ${m.text})`;
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

/**
 * Every Training conversation as each node's whole chat, by node: `{ chat, kind, setting?, lines }`, in file order. The
 * lines are the whole conversation as the judge reads a chat, each of that node's labels on the lines under the
 * message it is on (`want` lines, star left out), so a step sees the back-and-forth and what was wanted where.
 */
function chatsOf(conversations) {
  const nodes = {};
  for (const c of conversations) {
    if (c.set !== "training") continue;
    const msgs = c.msgs || [];
    const labelled = new Set();
    for (const m of msgs) if (!m.tex) for (const [node, l] of Object.entries(m.labels || {})) if (Object.keys(withoutStar(l)).length > 0) labelled.add(node);
    for (const node of labelled) {
      const lines = [];
      msgs.forEach((m, at) => {
        if (typeof m.at === "string" && m.at !== "") lines.push(`(${m.at})`);
        lines.push(lineOf(m, msgs.slice(0, at)));
        const label = m.tex ? null : withoutStar(m.labels?.[node]);
        if (label && Object.keys(label).length > 0) for (const want of wantLines(label)) lines.push(`    ${want}`);
      });
      (nodes[node] ??= []).push({ chat: c.id, kind: c.kind, ...(typeof c.setting === "string" ? { setting: c.setting } : {}), lines });
    }
  }
  return nodes;
}

function withoutStar(label) {
  const { star: _star, ...rest } = label || {};
  return rest;
}

/** What a step's prompt is told before whole Training conversations. */
const WHOLE_INTRO =
  'Whole conversations from Tex\'s Training Set ("You" is Tex, a person\'s name starts with "@"). Under a message, its tags say what this step should do on it: its output, and for an answer what it must and must never do. Handle new chats the way these are handled.';

/** One whole conversation in `<conversation>` tags. */
function conversationText(chat) {
  const about = chat.setting ? `\n<setting>${chat.setting}</setting>` : "";
  return `<conversation>\n<chat>${chatLine({ kind: chat.kind })}</chat>${about}\n${chat.lines.join("\n")}\n</conversation>`;
}

/**
 * A node's whole Training conversations within `chars` characters, intro included: whole conversations in file order,
 * one that does not fit left out whole (never cut mid-chat) and counted, "" when the node has none.
 */
function wholeText(node, chars, generated) {
  const chats = generated?.chats?.[node] ?? [];
  if (chats.length === 0) return "";
  const kept = [];
  let used = WHOLE_INTRO.length + "\n\n<conversations>\n</conversations>".length;
  for (const chat of chats) {
    const text = conversationText(chat);
    if (used + text.length + 1 > chars) continue;
    kept.push(text);
    used += text.length + 1;
  }
  const left = chats.length - kept.length;
  const note = left === 0 ? "" : `\n(${left} more Training conversation${left === 1 ? "" : "s"} left out: over this module's ${chars} characters)`;
  if (kept.length === 0) return "";
  return `${WHOLE_INTRO}\n\n<conversations>\n${kept.join("\n")}\n</conversations>${note}`;
}

/** The prompt module name an entry is given among a step's modules: `train-<node>` or `train-<node>-all-<chars>`. */
function trainName(entry) {
  const m = TRAIN_ENTRY.exec(entry);
  if (!m) return null;
  return m[2] === undefined ? `train-${m[1]}` : `train-${m[1]}-all-${m[2]}`;
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
  const entries = (step?.ctx ?? []).map((entry) => TRAIN_ENTRY.exec(entry)).filter(Boolean);
  const moments = entries.filter((m) => m[2] === undefined).flatMap((m) => generated?.nodes?.[m[1]] ?? []);
  const parts = [];
  if (moments.length > 0) parts.push(`${TRAINING_INTRO}\n\n<examples>\n${moments.map(exampleText).join("\n")}\n</examples>`);
  for (const m of entries) if (m[2] !== undefined) parts.push(wholeText(m[1], Number(m[2]), generated));
  return parts.filter((p) => p !== "").join("\n\n");
}

/** One module's text by its entry (`train:<nodeId>` or `train:<nodeId>:all:<chars>`), as the Lab shows it. */
function moduleText(entry, generated) {
  return TRAIN_ENTRY.test(entry) ? trainingText({ ctx: [entry] }, generated) : "";
}

module.exports = { TRAIN_ENTRY, WHOLE_INTRO, chatsOf, wholeText, conversationText, trainName, QUOTE_CHARS, HISTORY_LINES, historyLines, TRAINING_INTRO, lineOf, linesBefore, momentsOf, trainingSources, wantLines, exampleText, trainingText, moduleText };
