/**
 * THE MODEL ROUTER: WHICH MODEL ANSWERS THIS TEXT.
 *
 * Asked for by the owner (2026-10-09): "routing configs for the models, where
 * the routers route to different levels of intelligent models, Opus 5.5 being
 * a really smart model we invoke when we need the best reasoning."
 *
 * A setup names its everyday model (`models.main`) and may add a router and a
 * thinking model:
 *
 *   models:
 *     main: anthropic/claude-haiku-5-5
 *     router: "@cf/cloudflare/clef"
 *     think: anthropic/claude-opus-5-5
 *
 * Before the first model round, the router reads the person's text and picks
 * one of three tiers: `lookup` (one fact from the notes), `change` (edit one
 * note) or `think` (several notes, a judgement, a plan, something that goes
 * wrong when answered carelessly). `lookup` and `change` run on `main`;
 * `think` runs on `think`. The whole turn stays on the model picked, so the
 * tool rounds are coherent.
 *
 * Why Clef and not the cheap model deciding for itself: a model asked "do you
 * need help?" almost never says yes, and asking costs a whole round. Clef
 * (`decide.js`) answers a pick-one question in tens of milliseconds for a
 * fraction of a cent, reads and stores nothing, and its pick is a plain word
 * that can be checked by hand. A gateway dynamic route (`dynamic/<name>`)
 * cannot do this: it never sees the text, so it can split traffic and cap
 * spend but cannot tell a lookup from a hard question.
 *
 * Never throws, never blocks an answer: no engine, a failed call, an unknown
 * word or a low-confidence pick all mean `main`, recorded as such.
 */

import { decisionTokens } from "./decide.js";

/** The one router a setup may name, for now. */
export const ROUTER_MODEL = "@cf/cloudflare/clef";

/** The tiers the router may pick, in the order they are offered. */
export const TIERS = ["lookup", "change", "think"];

/** Below this, the pick is not trusted and the turn stays on `main`. */
const MIN_CONFIDENCE = 0.5;

/** The most of a long text the router reads. */
const MAX_TEXT_CHARS = 4_000;

const QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "The person texted their notes assistant. Which kind of request is this? " +
      "Pick think when answering well needs more than one place or one step: comparing commitments or checking whether the person can make an event, " +
      "several notes or several of their workspaces, a span of days, a plan, a judgement, an opinion, a conflict, a privacy decision, " +
      "a change together with a message to someone, or a request that could mean two different things. " +
      "A short question can still need several notes. Pick lookup or change only when one search or one edit in one known note settles it.",
    criteria: {
      lookup: "One fact, date, time or amount from their notes, answerable with one search in one place. Not attendance or feasibility, not a span of days.",
      change: "Add, change, tick off or move one thing in one note it is clear which; or a greeting, thanks or a quick reply with nothing to look up.",
      think: "Compare notes or workspaces, look over a span of days, make a judgement, give an opinion or a plan, resolve a clash, check whether the person can make an event or commitment, change a note and draft a message in one go, settle which of two things they mean, or handle privacy carefully.",
    },
  },
};

/**
 * The tier for one text, and what deciding it cost.
 *
 * @param {object} options
 * @param {(state: string, questions: object) => Promise<object|null>} options.decide
 *   the decision engine (`decisionEngine(env.AI)`), or null when there is none
 * @param {string} options.text the person's message
 * @param {Array<{role: string, text: string}>} [options.history] earlier turns,
 *   so a follow-up ("yes, do that") is read with what it follows
 * @returns {Promise<{tier: "main"|"think", pick: string|null, confidence: number|null, tokens: number}>}
 *   `tier` is where the turn runs; `pick` is the router's own word
 */
export async function pickTier({ decide, text, history = [] }) {
  if (typeof decide !== "function") return { tier: "main", pick: null, confidence: null, tokens: 0 };
  const recent = history
    .slice(-4)
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "Person"}: ${String(turn.text ?? "").slice(0, 500)}`);
  const state = [...recent, `Person (now): ${String(text ?? "").slice(0, MAX_TEXT_CHARS)}`].join("\n");
  const tokens = decisionTokens(state, QUESTIONS);
  let answers = null;
  try {
    answers = await decide(state, QUESTIONS);
  } catch {
    answers = null;
  }
  const pick = answers?.tier;
  if (typeof pick?.choice !== "string" || !TIERS.includes(pick.choice)) {
    return { tier: "main", pick: null, confidence: null, tokens };
  }
  const confidence = typeof pick.confidence === "number" ? pick.confidence : null;
  const trusted = confidence === null || confidence >= MIN_CONFIDENCE;
  return { tier: pick.choice === "think" && trusted ? "think" : "main", pick: pick.choice, confidence, tokens };
}
