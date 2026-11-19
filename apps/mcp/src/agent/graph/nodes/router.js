/**
 * The router node, `router` (texConfig.json, group "tools-subagents", off in main's config): beside the Door, Clef picks the
 * specialist door a text's turn goes through (`../../specialistRoute.js`, `../../doorTurn.js`). Wires: `doorStep ->
 * router` (uses; a check-in or a routine skips the Door and stays on today's front door), and `router -> handoff` (uses) when a long job should go to the Hand-off node at once.
 *
 * Input: the text, whether it came in a group, what started the turn, and the Shape gate's read when it had one.
 * What else it reads is its config's `ctx` (`../../routerContext.js`), read here from the turn's own chat and never
 * carried in the input, which stays plain and loggable: its Training examples, the chat's history as the front door
 * reads it, what Tex is doing now, today's date. A read not back within `CONTEXT_MS` is read as nothing.
 * Output: `{ route, sure, when }` with route quick, read, act, job, or "none" when there is no model here, the call
 * failed or ran out of time, or it named no route. Never throws.
 */
import { decisionEngine } from "../../decide.js";
import { ledgerPlace } from "../../ledger.js";
import { DEFAULT_TIME_ZONE, nowLine, readTimeZone } from "../../localNow.js";
import { routerWants } from "../../routerContext.js";
import { readRoute, routeRequest } from "../../specialistRoute.js";
import { carryKey } from "../../stretch.js";
import { TRAINING, texConfigOf, texStep, texTimeoutMs } from "../../texConfig.js";
import { nowFacts } from "../../textsDecide.js";
import { historyReads, weekTurn } from "../../weekHistory.js";

/** The longest the router may take when its config names no limit: Clef answers in about half a second. */
const DEFAULT_MS = 2_500;
/** The longest the router waits on the chat's ledger for its context modules; what isn't back by then it goes without. */
export const CONTEXT_MS = 600;
/** How much of today the `recent` module reads when no `chat:` module is named. */
const RECENT_READ = Object.freeze({ chat: Object.freeze({ days: 1, chars: 4_000 }), summaries: null });

const within = (read, ms) => {
  // `read` is called here, so a reader that throws is a read of nothing.
  let timer;
  return Promise.race([
    Promise.resolve().then(read).catch(() => null),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** The router's `ctx` in this turn's config (a Lab draft's, in a Lab test chat), or none. */
function routerCtx(env) {
  try {
    const ctx = texStep("router", texConfigOf(env)).ctx;
    return Array.isArray(ctx) ? ctx : [];
  } catch {
    return [];
  }
}

/**
 * The parts the router's context modules read for this turn (`routerContext.js` `routerContextText` takes them):
 * the history from the chat's ledger through the front door's own reader (`weekTurn`, the same grant), the facts
 * Decide reads (`nowFacts`), the date where they are, the Training module this process reads. Each ledger read is
 * capped at `waitMs`; none fails the turn.
 */
export async function routerReads(t, ctx, { waitMs = CONTEXT_MS, now = Date.now() } = {}) {
  const wants = routerWants(ctx);
  const place = ledgerPlace(t?.session);
  const ledger = place !== null && typeof t?.store?.texLedger === "function" ? t.store.texLedger(place.owner.chat ?? null) : null;
  const timeZone = readTimeZone(t?.body?.timeZone) ?? DEFAULT_TIME_ZONE;
  const at = Number.isFinite(t?.received) ? t.received : now;
  const reads = historyReads({ ctx }) ?? (wants.recent ? RECENT_READ : null);
  const [week, facts] = await Promise.all([
    reads !== null && ledger !== null ? within(() => weekTurn({ ledger, chat: place.chat, now: at, timeZone, reads, grant: carryKey(t.session), log: () => {} }), waitMs) : null,
    wants.facts && ledger !== null ? within(() => nowFacts(ledger, place.chat, { now: at, timeoutMs: waitMs }), waitMs + 50) : null,
  ]);
  return {
    ctx,
    training: wants.training ? TRAINING : null,
    history: typeof week?.history?.text === "string" ? week.history.text : "",
    facts: Array.isArray(facts) ? facts : [],
    today: wants.date ? nowLine(at, timeZone) : "",
  };
}

export async function routerNode(input, io) {
  const t = io?.ctx?.turn ?? {};
  const engine = io?.engine ?? decisionEngine(t.env?.AI);
  if (typeof engine !== "function" || typeof input?.question !== "string" || input.question.trim() === "") return { route: "none" };
  const read = typeof io?.reads === "function" ? io.reads : routerReads;
  const context = await Promise.resolve()
    .then(() => read(t, routerCtx(t.env)))
    .catch(() => null);
  const asked = routeRequest({ question: input.question, group: input.group === true, trigger: input.trigger, shape: input.shape ?? null, context });
  let limit = DEFAULT_MS;
  try {
    limit = texTimeoutMs("router");
  } catch {
    // a config with no limit for it: the default
  }
  const answers = await within(() => engine(asked.state, asked.questions), limit);
  const route = readRoute(answers);
  return route === null ? { route: "none" } : { route: route.route, sure: route.sure, ...(route.probs ? { probs: route.probs } : {}), when: [route.route] };
}
