/**
 * The steps this Worker takes on its own, kept in the chat's ledger beside
 * the gateway's (Dev2, 2026-11-13: "every step should log its input output
 * time and stuff, we need to be able to replay everything and track bugs and
 * regressions"): a person's own chat's judging (`inboxTurn.ts` `ask`; a
 * group's is kept by the gateway, `textsDecide.js`) and every tapback Tex
 * sends, in a 1:1 chat or a group.
 *
 * Each is one `step` event in the outbox (`events.ts`), posted with the chat's
 * other events to `/agent/events`, where the gateway keeps it as a `step`
 * entry (`apps/mcp/src/agent/ledger.js` `eventEntry`). It is never a line of
 * the chat: every reader of the outbox leaves it out (`keptEvents`,
 * `recentEvents`), and the gateway never reads it back as a text.
 *
 * A step holds ids, codes, counts and emoji, never anyone's words. Logging
 * never throws and never slows the step: a step that could not be kept is
 * only missing from the record.
 */

import { ackEmoji } from "./ackEmoji";
import { addEvent } from "./events";
import { reactionFor } from "./reactEmoji";
import type { Decision, DecideAsk } from "./decide";
import type { InboxStorage } from "./inbox";

export type StepName = "decide" | "react";
/** One step as the gateway takes it (`apps/mcp/src/agent/log.js` `checkStep`). */
export type StepRecord = {
  name: StepName;
  /** Which kind of the step: the judging of waiting texts or of one that came mid-turn; who chose a tapback. */
  of?: string;
  ok: boolean;
  ms?: number;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** Why it failed, as a code. */
  cause?: string;
};

const CODE = /[^\w-]/g;
/** What the gateway takes (`apps/mcp/src/agent/log.js` `checkStep`): an input or output over this as JSON is kept as its size alone. */
const MAX_PART_JSON = 3_500;
const TURN = /^[A-Za-z0-9_-]{8,64}$/;
const bounded = (part: Record<string, unknown> | undefined) => {
  if (part === undefined) return undefined;
  const chars = JSON.stringify(part).length;
  return chars > MAX_PART_JSON ? { cut: chars } : part;
};
const code = (value: string | undefined) => (value ?? "").replace(CODE, "").slice(0, 40) || undefined;

/** Keep one step of `chat` for the gateway. Never throws. */
export async function logStep(storage: InboxStorage, chat: string, step: StepRecord, now: number, turn?: string): Promise<void> {
  try {
    const ms = step.ms !== undefined && Number.isFinite(step.ms) && step.ms >= 0 ? { ms: Math.round(step.ms) } : {};
    const [of, cause, input, output] = [code(step.of), code(step.cause), bounded(step.input), bounded(step.output)];
    const kept: StepRecord = { name: step.name, ok: step.ok, ...ms, ...(of ? { of } : {}), ...(input ? { input } : {}), ...(output ? { output } : {}), ...(cause ? { cause } : {}) };
    await addEvent(storage, { at: now, chat, from: { kind: "system" }, kind: "step", step: kept, ...(turn !== undefined && TURN.test(turn) ? { turn } : {}) });
  } catch {
    /* a step's record never stops the step */
  }
}

/**
 * The judge's verdict on a person's own waiting texts: what it was asked (the
 * ids, never the transcript's words, which are the chat's own texts already
 * in the ledger) and what it answered.
 */
export function decideStep(ask: Pick<DecideAsk, "style" | "candidates" | "newest" | "running" | "waitingAsks" | "transcript">, decision: Decision): StepRecord {
  const input = { style: ask.style, running: ask.running, candidates: ask.candidates, newest: ask.newest, waitingAsks: ask.waitingAsks.length, transcriptChars: ask.transcript.length };
  if (!decision.ok) return { name: "decide", of: ask.running ? "running" : "waiting", ok: false, ms: decision.ms, input, output: { reason: decision.reason }, cause: decision.cause ?? decision.reason };
  const { ok: _ok, ms, ...said } = decision;
  return { name: "decide", of: ask.running ? "running" : "waiting", ok: true, ms, input, output: said };
}

/**
 * Send a tapback on a text and keep it as a step: who chose it (`by`: the
 * judge, the classifier, a tool starting), the emoji it asked for (sent when
 * it is one of the 64, else one picked from the text's words: `reactionFor`,
 * `ackEmoji`), the one sent, on which event, how long the line took, and
 * whether it went. A send that throws is kept as failed and thrown on.
 */
export async function tapback(
  storage: InboxStorage,
  where: { chat: string; now: () => number; by: string; asked?: string; on?: string; turn?: string },
  words: string,
  send: (emoji: string) => Promise<unknown>,
): Promise<void> {
  const emoji = reactionFor(where.asked, ackEmoji(words));
  // Timed on the wall clock: `now` is when it happened, which some callers fix for the whole text.
  const began = Date.now();
  const input = { by: where.by, ...(where.asked ? { asked: where.asked } : {}), ...(where.on ? { on: where.on } : {}) };
  const kept = (ok: boolean, cause?: string) => logStep(storage, where.chat, { name: "react", of: where.by, ok, ms: Date.now() - began, input, output: { emoji }, ...(cause ? { cause } : {}) }, where.now(), where.turn);
  try {
    await send(emoji);
  } catch (error) {
    await kept(false, error instanceof Error ? error.name : "error");
    throw error;
  }
  await kept(true);
}
