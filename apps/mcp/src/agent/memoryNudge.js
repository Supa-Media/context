/**
 * THE MEMORY NUDGE: EVERY 10 TEXTS, TEX SAVES WHAT IT LEARNED (Dev, 2026-10-19).
 *
 * Tex is told on every turn to keep `tex/about-me.md` current, and often
 * doesn't: it is busy with the job. The nightly dream catches up, but a fact
 * from this morning is missing all day. Hermes answers this with a nudge
 * every 10 user turns, and so does Tex: after a texted turn has answered
 * (deferred, so nobody waits), once 10 of the person's texts have come since
 * the last nudge, one small built-in-model turn reads their recent texts and
 * may write `tex/about-me.md` once, or answer NONE.
 *
 * It is shown the words of untainted exchanges only: an exchange whose answer
 * read from outside the workspace is left out whole, because what it writes is
 * read as Tex's own memory on every later turn. It may call `read_note` and
 * `write_note` on `tex/about-me.md` in their own workspace and nothing else
 * (`nudgeCallTool`), and the note's own size limit holds (`aboutMe.js`).
 *
 * It also runs at once when their newest text answers a question Tex asked
 * them (`answersAskAboutThem`): that is how a home address arrives.
 *
 * The count is kept in `.context/agent/memory-nudge.json` as the time of the
 * newest text the last nudge saw, so a text is counted once whether or not its
 * exchange was saved before this ran. The first turn after this shipped only
 * sets it: nobody gets a nudge over texts from before.
 */

import { runTurn } from "./turn.js";
import { builtinModel } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { ProviderError } from "./providers.js";
import { builtinMeter } from "./jobLog.js";
import { readConversation } from "./conversation.js";
import { ABOUT_ME_PATH, MAX_ABOUT_ME_LINES } from "./aboutMe.js";

/** Texts from the person between nudges. */
export const NUDGE_EVERY = 10;
export const NUDGE_ROUNDS = 3;
export const NUDGE_MARKER = ".context/agent/memory-nudge.json";
/** Exchanges read back: the 10 since the last nudge, with room for Tex's own texts between them. */
const READ_EXCHANGES = 20;
const MAX_TEXT_SHOWN = 1_000;
const NONE = "NONE";
const WRITE_ARGS = new Set(["path", "content", "expected_etag"]);

function refused(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/** `read_note` and one `write_note`, on `tex/about-me.md` in their own workspace only. */
export function nudgeCallTool(dispatch) {
  let wrote = false;
  const call = async (name, args) => {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (given.context !== undefined) return refused("Only their own workspace.");
    if (name !== "read_note" && name !== "write_note") return refused(`This can't use ${String(name).slice(0, 40)}.`);
    if (given.path !== ABOUT_ME_PATH) return refused(`Only ${ABOUT_ME_PATH} can be read or written here.`);
    if (name === "read_note") return await dispatch("read_note", { path: ABOUT_ME_PATH });
    if (wrote) return refused("It was written once already. Stop here.");
    const extra = Object.keys(given).filter((key) => given[key] !== undefined && !WRITE_ARGS.has(key));
    if (extra.length > 0) return refused(`Written with path, content and expected_etag only: ${extra.join(", ")} can't be set.`);
    const written = await dispatch("write_note", {
      path: ABOUT_ME_PATH,
      content: given.content,
      ...(typeof given.expected_etag === "string" ? { expected_etag: given.expected_etag } : {}),
    });
    if (written?.isError !== true) wrote = true;
    return written;
  };
  call.wrote = () => wrote;
  return call;
}

/**
 * The person's texts since `since`, as exchanges oldest first, and the time of
 * the newest. `shown` keeps only the untainted ones.
 */
export function textsSince(history, since) {
  const exchanges = [];
  for (let i = 0; i < history.length; i += 1) {
    const turn = history[i];
    if (turn.role !== "user" || turn.theirs !== true || !Number.isFinite(turn.at) || turn.at <= since) continue;
    const answer = history[i + 1]?.role === "assistant" ? history[i + 1] : null;
    exchanges.push({ at: turn.at, question: turn.text, answer: answer?.text ?? "", tainted: answer?.tainted === true });
  }
  return {
    count: exchanges.length,
    newest: exchanges.reduce((most, exchange) => Math.max(most, exchange.at), since),
    shown: exchanges.filter((exchange) => !exchange.tainted),
  };
}

/**
 * Whether their newest text answers a question Tex asked about them ("Your
 * home address isn't in your notes ... What is it?"): a fact given that way
 * is kept now, not ten texts later (the owner, 2026-10-23).
 */
const ABOUT_THEM =
  /\byour\s+(?:\w+\s+){0,2}(?:address|home|birthday|email|phone|number|work|office|job|partner|wife|husband|kids?|children|daughter|son|name|allerg\w*|diet|car|commute|school|gym|doctor|dentist|time ?zone|size)\b|\bwhere do you (?:live|work)\b|\bwhen(?:'s| is) your\b/i;

export function answersAskAboutThem(history) {
  for (let i = history.length - 1; i > 0; i -= 1) {
    if (history[i].role !== "user" || history[i].theirs !== true) continue;
    const asked = history[i - 1];
    if (asked?.role !== "assistant" || typeof asked.text !== "string") return false;
    const last = asked.text.trim().split(/\n+/).at(-1) ?? "";
    return /\?\s*$/.test(last) && ABOUT_THEM.test(asked.text);
  }
  return false;
}

/** The history with this turn's text and answer at the end, when it isn't there yet. */
function withThisTurn(history, current, now) {
  if (typeof current?.question !== "string" || current.question.trim() === "") return history;
  const lastTheirs = [...history].reverse().find((turn) => turn.role === "user" && turn.theirs === true);
  if (lastTheirs?.text === current.question) return history;
  return [
    ...history,
    { role: "user", theirs: true, text: current.question, at: now },
    { role: "assistant", text: String(current.answer ?? ""), ...(current.tainted === true ? { tainted: true } : {}) },
  ];
}

const cut = (text) => {
  const words = String(text ?? "").trim();
  return words.length > MAX_TEXT_SHOWN ? `${words.slice(0, MAX_TEXT_SHOWN)}…` : words;
};

/** What the nudge is asked. */
export function nudgeQuestion(shown) {
  return [
    "This is not a text from a person. Nobody is waiting, and nothing you say is texted to anyone.",
    `Below are your latest texts with them. Is there anything lasting about them in these that ${ABOUT_ME_PATH} doesn't hold yet: ` +
      "a preference, a correction, someone in their life, a plan or routine, how they like things done? " +
      `If so, read ${ABOUT_ME_PATH} with fetch, then write it back whole with the new facts added, passing its etag: one short line per fact, ` +
      `merge rather than repeat, never more than ${MAX_ABOUT_ME_LINES} lines, and never a secret, a code or a password. Then answer DONE. ` +
      `If nothing new is worth keeping, answer exactly ${NONE} and call nothing.`,
    `## Your latest texts\n\n${shown.map((exchange) => `They: ${cut(exchange.question)}\nYou: ${cut(exchange.answer)}`).join("\n\n")}`,
  ].join("\n\n");
}

async function readMarker(store) {
  try {
    const object = await store.get(NUDGE_MARKER);
    if (!object) return null;
    const at = JSON.parse(await object.text())?.at;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function log(session, fields) {
  console.log(JSON.stringify({ event: "memory_nudge", workspace: session.workspaceId, grant: session.grantId, ...fields }));
}

/**
 * After a texted turn that could write in their personal workspace: nudge
 * once `NUDGE_EVERY` of their texts have come since the last time. Never
 * throws, never texts.
 */
export async function memoryNudge({ env, controlPlane, store, session, offered, dispatch, now = Date.now(), current = null }) {
  try {
    const history = await readConversation(store, "texts", { entries: READ_EXCHANGES });
    const marker = await readMarker(store);
    if (marker === null) {
      // Counting starts now, not over texts from before there was a nudge.
      const latest = history.reduce((most, turn) => (Number.isFinite(turn.at) ? Math.max(most, turn.at) : most), 0);
      await store.put(NUDGE_MARKER, JSON.stringify({ at: latest || now }));
      return;
    }
    const counted = textsSince(history, marker);
    // This turn's own exchange is saved after this runs, so it is added here to see what it answered.
    const withCurrent = withThisTurn(history, current, now);
    const asked = withCurrent !== history && answersAskAboutThem(withCurrent);
    if (counted.count < NUDGE_EVERY && !asked) return;
    const since = asked ? textsSince(withCurrent, marker) : counted;
    // Their own answer is theirs even when Tex's reply read a page: it is shown, and that reply is not.
    if (asked && current.tainted === true) since.shown.push({ at: now, question: current.question, answer: "", tainted: false });
    // Counted whatever comes of it, so a failing nudge is not retried every text.
    await store.put(NUDGE_MARKER, JSON.stringify({ at: since.newest }));
    if (since.shown.length === 0) return log(session, { outcome: "nothing_shown", texts: since.count });

    const tools = (Array.isArray(offered) ? offered : []).filter((tool) => tool.name === "read_note" || tool.name === "write_note");
    const model = builtinModel(env);
    const meter = builtinMeter(controlPlane, session, model, Date.now());
    const callTool = nudgeCallTool(dispatch);
    let ran;
    try {
      ran = await runTurn({
        question: nudgeQuestion(since.shown),
        tools,
        grants: { write: ["save"] },
        callTool,
        env,
        providerOptions: {
          ai: env.AI,
          gateway: aiGatewayConfig(env),
          metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "memory_nudge" },
        },
        maxRounds: NUDGE_ROUNDS,
        roundCap: NUDGE_ROUNDS,
      });
    } catch (error) {
      await meter(null, true, error instanceof ProviderError ? error.model : model);
      return log(session, { outcome: "failed", code: error instanceof ProviderError ? "provider" : "error" });
    }
    await meter(ran.usage, false, ran.model);
    log(session, { outcome: callTool.wrote() ? "wrote" : ran.exhausted ? "exhausted" : "none", texts: since.count });
  } catch (error) {
    log(session ?? {}, { outcome: "failed", code: error?.name === "TypeError" ? "type" : "error" });
  }
}
