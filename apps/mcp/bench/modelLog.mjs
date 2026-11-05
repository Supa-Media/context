/**
 * EVERYTHING A BENCHMARK CONVERSATION DID, IN ONE FILE PER CONVERSATION.
 *
 * Asked for by the owner (2026-11-05), after a round where nobody could say
 * whether Tex missed a note because search never showed it or because the
 * model ignored it: "we should be logging everything the models do in these
 * benchmarks, create a form of the history.ledger.json files that we can
 * inspect so we can improve".
 *
 * Each conversation keeps:
 * - `chat`: the chat's own ledger, as the product writes it (`src/agent/ledger.js`):
 *   every tool call with its arguments and result, the replies, the thinking.
 *   A read of another workspace keeps its call and not its result there, as in
 *   production, which is why the model calls below are kept too.
 * - `model`: every model request and answer as it went over the wire (`modelLog`):
 *   the system prompt once, then each round's new messages (the tool results the
 *   model was shown, whatever workspace they came from) and what it answered.
 * - `turns`: each turn's trace (router, fallback, the reply judge's verdict).
 * - `conversation`: the texts both ways.
 *
 * Every name and note in a benchmark world is invented, so nothing here is
 * anybody's data. The files go beside the result and into Context with the
 * scores (`context.mjs`), as `.ledger.md` notes the app can open.
 */

import { basename, dirname, join } from "node:path";

import { realNow } from "./clock.mjs";

/** The longest a single text in a ledger file is kept, in characters: a whole conversation stays readable in one note. */
export const MAX_TEXT_CHARS = 12_000;

/** One ledger file's ceiling, in characters; past it the oldest model rounds are dropped first, and the file says so. */
export const MAX_LEDGER_CHARS = 900_000;

const clip = (text, max = MAX_TEXT_CHARS) => (typeof text === "string" && text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);

/** Long strings anywhere in a value, clipped; the shape is kept. */
export function clipDeep(value, depth = 0) {
  if (typeof value === "string") return clip(value);
  if (depth > 12 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => clipDeep(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipDeep(item, depth + 1)]));
}

/**
 * A model fetch that keeps every call it passes on: `{ fetch, calls() }`.
 * A call is `{ at, ms, status, model, system?, messages, answer }`: the system
 * prompt only when it changed, and only the messages new since the call
 * before, so a long turn is not kept once per round. Recording never changes
 * or fails the call.
 */
export function modelLog(inner, { now = realNow } = {}) {
  const calls = [];
  let lastSystem = null;
  let lastMessages = [];
  return {
    async fetch(url, init) {
      const started = now();
      const response = await inner(url, init);
      try {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        const continues = messages.length >= lastMessages.length && lastMessages.every((m, i) => JSON.stringify(m) === JSON.stringify(messages[i]));
        const fresh = continues ? messages.slice(lastMessages.length) : messages;
        lastMessages = messages;
        const system = typeof body?.system === "string" ? body.system : body?.system ? JSON.stringify(body.system) : null;
        const text = await response.clone().text();
        let answer;
        try {
          answer = JSON.parse(text);
        } catch {
          answer = text;
        }
        calls.push({
          at: started,
          ms: now() - started,
          status: response.status,
          model: body?.model ?? null,
          ...(system !== lastSystem ? { system } : {}),
          ...(continues ? {} : { restarted: true }),
          tools: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name).filter(Boolean) : [],
          messages: fresh,
          answer: answer && typeof answer === "object" ? { content: answer.content ?? null, stop_reason: answer.stop_reason ?? null, usage: answer.usage ?? null } : answer,
        });
        lastSystem = system;
      } catch {
        // A call the log cannot read is still the model's call: the turn goes on.
      }
      return response;
    },
    calls: () => calls,
  };
}

/** The entries of a history file read back through the gateway (`tex/history.ledger.json`), or [] when there is none. */
export function chatEntries(read) {
  const body = typeof read?.body === "string" ? read.body : "";
  const start = body.indexOf("{");
  if (start === -1) return [];
  try {
    const parsed = JSON.parse(body.slice(start));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

/** One conversation's ledger file, as JSON-ready data, kept under `MAX_LEDGER_CHARS`. */
export function benchLedger({ setup, question, run, as, questionText, conversation = [], turns = [], chat = [], calls = [] }) {
  const ledger = {
    schema: "bench-ledger",
    version: 1,
    setup,
    question,
    run,
    as,
    questionText,
    conversation: clipDeep(conversation),
    turns: clipDeep(turns),
    chat: clipDeep(chat),
    model: { calls: clipDeep(calls) },
  };
  let dropped = 0;
  while (JSON.stringify(ledger).length > MAX_LEDGER_CHARS && ledger.model.calls.length > 1) {
    // The first call keeps the system prompt; the oldest rounds after it go first.
    ledger.model.calls.splice(1, 1);
    dropped += 1;
  }
  if (dropped > 0) ledger.model.dropped = dropped;
  return ledger;
}

/** Where a result's ledger files go: `<folder>/<result name> ledgers/`, beside it. */
export function ledgersFolderFor(resultFile) {
  return join(dirname(resultFile), `${basename(resultFile, ".md")} ledgers`);
}

/** A ledger's file name: `production q14 run 2.ledger.md`. */
export function ledgerFileName({ setup, question, run }) {
  return `${setup} q${question} run ${run}.ledger.md`;
}

/** A ledger as a note: a line on what it is, then the JSON in one block, so the app shows it and a reader can copy it out. */
export function ledgerNote(ledger, { round = null } = {}) {
  const json = JSON.stringify(ledger, null, 2).replaceAll("```", "`​``");
  return [
    "---",
    "role: benchmark-ledger",
    `setup: ${ledger.setup}`,
    `question: ${ledger.question}`,
    `run: ${ledger.run}`,
    ...(round ? [`round: ${round}`] : []),
    "---",
    "",
    `# ${ledger.setup} q${ledger.question} run ${ledger.run}`,
    "",
    "Everything this benchmark conversation did (`apps/mcp/bench/modelLog.mjs`): the texts, each turn's trace, the chat's ledger, and every model request and answer.",
    "",
    "```json",
    json,
    "```",
    "",
  ].join("\n");
}
