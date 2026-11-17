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
import { readArrival, type ProviderArrival, type ProviderSend } from "./providerTiming";

export type StepName = "triage" | "decide" | "react" | "text" | "send" | "oldLine" | "moveChat" | "edit";
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
 * A text arrives (the config's `text` node): which provider brought it, its own time for the text, when the webhook
 * came, the lag between, any status or error it gave, and what the chat's queue did with it (Dev2, 2026-11-14). `ms`
 * is the provider's lag, so a slow provider shows as a slow step.
 */
export function textStep(ev: string | undefined, kind: "one" | "group" | "react" | "edit", provider: ProviderArrival, outcome: string, queuedAt: number, reason?: string): StepRecord {
  const ok = provider.error === undefined && outcome !== "dropped";
  return {
    name: "text",
    of: kind,
    ok,
    ...(provider.lagMs !== undefined ? { ms: provider.lagMs } : {}),
    input: { ...(ev ? { ev } : {}), provider },
    output: { outcome, ...(reason ? { reason } : {}), queuedAt, ...(provider.lagMs !== undefined ? { lagMs: provider.lagMs } : {}) },
    ...(ok ? {} : { cause: provider.error?.code ?? reason ?? outcome }),
  };
}

/**
 * A message the line dropped in a chat (`photonEvents.ts` noteDropped, the object's `/dropped`): its `text` step, outcome
 * "dropped" with the reason, never the words. False for a body that names no chat, kind, reason or provider time.
 */
export async function logDropped(storage: InboxStorage, body: unknown, now: number): Promise<boolean> {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const provider = readArrival(b.provider);
  if (typeof b.chat !== "string" || b.chat === "" || (b.kind !== "one" && b.kind !== "group") || typeof b.reason !== "string" || provider === undefined) return false;
  await logStep(storage, b.chat, textStep(undefined, b.kind, provider, "dropped", now, b.reason), now);
  return true;
}

/** A send's status from its provider (the config's `send` node): `ms` is how long the provider took to reach it. */
export function sendStep(report: ProviderSend): StepRecord {
  const ok = report.status !== "failed";
  return {
    name: "send",
    of: report.status,
    ok,
    ...(report.lagMs !== undefined ? { ms: report.lagMs } : {}),
    input: { provider: report.name, handle: report.handle },
    output: { ...report },
    ...(ok ? {} : { cause: report.error?.code ?? "failed" }),
  };
}

/**
 * Text them's own work (the config's `send` node): this Worker handing the turn's reply to the chat's service, part by
 * part, after the gateway answered (Dev2, 2026-11-15: "The Text them node doesnt seem to be logging the actual time it
 * takes"). The gateway's `send` node only builds the reply; the time it takes to reach the service is spent here, so
 * it is kept as its own `send` step, `of: "delivery"`, under the turn it delivers. `ms` is the wall time from the first
 * part handed over to the last one taken; a failure keeps its error's name.
 */
export function deliveryStep(parts: number, sent: number, ms: number, cause?: string): StepRecord {
  return { name: "send", of: "delivery", ok: cause === undefined, ms, input: { parts }, output: { sent }, ...(cause !== undefined ? { cause } : {}) };
}

/**
 * Triage: code's rules over a person's waiting texts, before any judge (`inboxTurn.ts` `chooseTurn`, `groupInbox.ts`
 * `acceptGroup`; Dev2, 2026-11-14: "everything needs a node ... where else is there random code running"). It names the
 * texts it looked at, by id, where it sent them (`to`: "tex" straight to the queue, "judge" to Decide, "running" put to
 * the judge beside the turn already running) and the rule that did it.
 */
export function triageStep(candidates: string[], to: "tex" | "judge" | "running", why: string, more: Record<string, unknown> = {}): StepRecord {
  return { name: "triage", of: to, ok: true, ms: 0, input: { texts: candidates, ...more }, output: { to, why } };
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
