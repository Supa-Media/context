/**
 * ADVISOR FIRST (Dev2, 2026-11-06: "advisor-first design for Tex, bench first, then a flagged build").
 *
 * With `advisor_first: on` in the setup (`production.js`), a texted turn
 * starts and stays on `models.main` (Haiku): the router never sends the whole
 * turn to `models.think`. The judgment comes from the advisor instead
 * (`advisor.js`), which the everyday model asks itself. A background job still
 * plans as before (`modelPlan.js`). Off by default: a setup without the key
 * runs exactly as it did.
 *
 * With `effort_rung: <level>` as well, a text the router flags as needing
 * thought (or that `pushback.js` marks as asking for Tex's judgment), and a
 * text sent back by an answer check, runs at that effort for the rest of the
 * turn. It goes as an effort-only system message after the person's text
 * (`providers.js`), Anthropic's per-message effort, which keeps the prompt
 * cache; a top-level change would start it over
 * (https://platform.claude.com/docs/en/build-with-claude/effort, "Change effort
 * mid-conversation", beta header `mid-conversation-output-config-2026-07-01`).
 * Whether Cloudflare AI Gateway passes that header on is unverified, so the
 * gateway resends once without the rung when it is refused (`aiGateway.js`).
 * Without `effort_rung` the router is never called for a text.
 */

import { thinkRoundsFor } from "./modelPlan.js";

/** The models the docs list for per-message effort on the Claude API (2026-11-06). Any other model is never sent a rung. */
export const PER_MESSAGE_EFFORT = /^anthropic\/claude-(?:haiku-5-5|sonnet-5-5|opus-5-5|opus-5|fable-5-1|mythos-5-1)$/;

/** The model, plan and rung a router's pick gives a turn. Advisor first: always `main`, never a plan. */
export function routedTurn(router, routed, main, advising) {
  if (advising) return { model: main, plan: null, rung: routed.tier === "think" ? router.rung ?? null : null };
  return { model: routed.tier === "think" && router.think ? router.think : main, plan: thinkRoundsFor(router, routed.tier, main), rung: null };
}

/** Raises this turn's effort to `level` once, after the newest text, on a model that takes it. */
export function raiseOnce(messages, level, model) {
  if (typeof level !== "string" || !PER_MESSAGE_EFFORT.test(model) || messages.some((message) => message.role === "effort")) return false;
  messages.push({ role: "effort", effort: level });
  return true;
}

/** `{ rung: level }` for a round's trace when the turn runs at a rung, else `{}`. */
export function rungOf(messages) {
  const rung = messages.find((message) => message.role === "effort");
  return rung ? { rung: rung.effort } : {};
}

/** Drops the rung: another model (the fallback) is never sent one. */
export function dropRungs(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === "effort") messages.splice(i, 1);
}
