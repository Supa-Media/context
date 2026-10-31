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

/*
  THE PLAN IS WRITTEN DOWN. A switch drops the planner's thinking (`turn.js`:
  it is the other model's, and outside a recorded turn it comes back empty
  anyway), so a plan that lived only in thinking never reached the driver.
  Golden tasks gh-63 (2026-10-18) showed it: after "I'm signed in", Haiku
  drove six browse calls blind, four failed, and Tex gave up on a form the
  production setup filled. So the planner is told to put the plan in words,
  which do survive the switch (they are never texted: progress goes through
  `send`), and the driver is told those words are its plan. gh-65 then showed
  Haiku reading a lingering sign-in page after "Done, I'm signed in" and
  asking her to sign in again three times, where Opus reopens the page.
*/
export const PLANNER_PROMPT =
  "\n\nYou plan this turn and a faster model carries it out. It cannot read your thinking, only your words and tool calls, " +
  "so before your first tool call write the plan in a few short lines: each step, the exact pages or addresses, what is already " +
  "true (signed in, which account, what is connected) and what done looks like. These lines are not texted to the person.";

export const DRIVER_PROMPT =
  "\n\nA planning model started this turn; its plan is in its words above. Carry it out step by step without redoing what it " +
  "found or contradicting what it established. When the person says they signed in, open the page you need again before deciding it " +
  "didn't work: a sign-in page can linger. When a step fails, try the next sensible way once, then say plainly what is blocked.";

/**
 * The router a turn runs with, from a setup this deployment can call: the
 * setup's router (Clef picks each text's tier), or, with only a planner
 * (`think` and `think_rounds`, no router; the owner, 2026-10-31: "Opus plans,
 * Haiku executes" for jobs), one that never decides: `jobsOnly`, so a
 * background job's turn plans on `think` and every other text stays on
 * `main`. Null when the setup has neither or `think` can't be called.
 *
 * @param {{router: object|null, planner?: {think: string, thinkRounds: number}|null}} setup
 * @param {(model: string) => boolean} canRun
 * @param {() => Function} decide the decision engine, made only for a router
 */
export function turnRouter(setup, canRun, decide) {
  const { router, planner = null } = setup;
  if (router !== null && canRun(router.think)) return { decide: decide(), think: router.think, routeAt: router.routeAt, thinkRounds: router.thinkRounds };
  if (router === null && planner !== null && canRun(planner.think)) return { decide: null, think: planner.think, thinkRounds: planner.thinkRounds, jobsOnly: true };
  return null;
}

/**
 * The plan for one routed turn, or null when the whole turn stays on one model.
 *
 * @param {{think: string, thinkRounds?: number}|null} router the setup's router
 * @param {"main"|"think"} tier what the router picked
 * @param {string} main the setup's everyday model
 */
export function thinkRoundsFor(router, tier, main) {
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
