/**
 * OPUS PLANS, HAIKU DRIVES: WHICH MODEL RUNS EACH ROUND OF A ROUTED TURN.
 *
 * Asked for by the owner (2026-10-17): "Opus does the thinking, Haiku executes
 * the task, small level thinking, like, oh, what element should I click … But
 * Opus should be doing the broader strokes thinking … a target percentage of,
 * like, 20% Opus, 80% Haiku."
 *
 * A setup with a router may name `models.think_rounds` (`production.js`), a
 * whole number 1-9. When the router sends a text to `think`, the first
 * `think_rounds` model rounds run on `think` (it reads the question, plans and
 * makes the first calls) and every later round runs on `main` (it drives: the
 * next click, the next read, the summary). A round whose tool calls included
 * a failure sends the next round back to `think`, once: a driver that just hit
 * a wall is the moment the planner is worth paying for. A call the egress gate
 * held for the person's yes is not a failure (`route.js` runs it when they
 * give it), so it never escalates.
 *
 * Without `think_rounds`, a routed turn stays on the model the router picked,
 * exactly as before (`router.js`).
 *
 * Mixed turns are priced per model: `usageByModel` keeps what each model
 * spent, and `meterParts` turns it into one meter report per model, so a turn
 * that was two rounds of Opus and six of Haiku is not billed as eight of
 * either.
 */

/**
 * The plan for one routed turn, or null when the whole turn stays on one model.
 *
 * @param {{think: string, thinkRounds?: number}|null} router the setup's router
 * @param {"main"|"think"} tier what the router picked
 * @param {string} main the setup's everyday model
 */
export function planFor(router, tier, main) {
  if (router === null || tier !== "think") return null;
  const rounds = router.thinkRounds;
  if (!Number.isInteger(rounds) || rounds < 1) return null;
  if (typeof router.think !== "string" || router.think === main) return null;
  return { think: router.think, main, rounds };
}

/**
 * The model round `round` runs on, and why: `plan` (one of the planning
 * rounds), `escalated` (the last round had a failed call) or `drive`.
 *
 * @param {{think: string, main: string, rounds: number}} plan
 * @param {number} round 0-based
 * @param {boolean} escalate the previous round's tool calls included a failure
 */
export function modelForRound(plan, round, escalate) {
  if (round < plan.rounds) return { model: plan.think, reason: "plan" };
  if (escalate) return { model: plan.think, reason: "escalated" };
  return { model: plan.main, reason: "drive" };
}

/** Whether a tool's answer is one that sends the next round to the planner. */
export function failedCall(result) {
  return result?.isError === true && result?.held !== true;
}

/** Add one round's usage to the model that spent it. */
export function addModelUsage(byModel, model, usage) {
  if (!usage) return;
  const into = (byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  into.input += usage.input ?? 0;
  into.output += usage.output ?? 0;
  into.cacheRead += usage.cacheRead ?? 0;
  into.cacheWrite += usage.cacheWrite ?? 0;
}

/**
 * Meter a finished turn, one call per model in `meterParts` order:
 * `meter(part, failed, model, whole)` as `route.js` defines it.
 */
export async function meterEach(turn, meter) {
  for (const part of meterParts(turn)) await meter(part, false, part.model, part.whole);
}

/**
 * One meter report per model a finished turn ran on, the model that wrote the
 * answer last (so a reader that takes the last report sees the answering
 * model, as before). The turn's own counts, the router's decision tokens and
 * the duration, ride on that last report only, so they are counted once.
 * A turn from before `usageByModel` (or a stub) is one report, as it was.
 *
 * @param {{model: string, usage?: object, usageByModel?: object}} turn
 * @returns {Array<{model: string, input: number, output: number, cacheRead: number, cacheWrite: number, decision: number, whole: boolean}>}
 */
export function meterParts(turn) {
  const usage = turn?.usage ?? {};
  const byModel = turn?.usageByModel;
  const entries = byModel && typeof byModel === "object" ? Object.entries(byModel) : [];
  if (entries.length === 0) {
    return [{ model: turn?.model, input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, decision: usage.decision ?? 0, whole: true }];
  }
  const ordered = [...entries.filter(([model]) => model !== turn.model), ...entries.filter(([model]) => model === turn.model)];
  return ordered.map(([model, spent], index) => {
    const last = index === ordered.length - 1;
    return { model, ...spent, decision: last ? usage.decision ?? 0 : 0, whole: last };
  });
}
