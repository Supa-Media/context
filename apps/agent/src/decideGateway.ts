/**
 * Decide and the last look asked of Clef in the gateway, over the `TexTexts` binding (Dev2's pick, 2026-11-05:
 * decide moves into the gateway, its daily cap and usage rows kept). The control plane keeps both, off each text's
 * path:
 *  - the gate (`/agent-texts/decide/gate`: may this chat decide today, and how many are left) is asked now and then
 *    and kept here for a few minutes; once it is old it is still used while a fresh one is asked beside the text;
 *  - what was decided is reported after the answer is in (`/agent-texts/decide/usage`): counts and characters, never words.
 * A gateway that cannot be reached returns null, and the caller asks the control plane's own route as before.
 */

import { post, record, type Fetch } from "./clients";
import type { TextsBinding } from "./gatewaySession";

/** The gateway's routes on the `TexTexts` binding (`apps/mcp/src/agent/textsDecide.js`). */
export const GATEWAY_DECIDE_URL = "https://gateway/texts/decide";
export const GATEWAY_RECHECK_URL = "https://gateway/texts/recheck";
/** A gate is kept this long, then still used while a fresh one is asked: the cap may run over by what one chat decides in that time. */
export const GATE_FOR_MS = 5 * 60_000;
/** A refusal is kept for less: a chat whose plan changes is let back in soon. */
export const REFUSED_FOR_MS = 60_000;
/** The refusal's cause for a group whose row the control plane has not made yet: never kept. */
export const NOT_SET_UP = "no_group";

export type MeterDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  texts?: { binding: TextsBinding };
  /** Keeps the object alive while the usage report and a gate refresh finish (`index.ts` `handOff`). */
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
};

/** Who is metered, as decide names the chat: a group by its line and id, a 1:1 by its sender. */
export type Metered = { chat: string; style: string; line?: string; sender?: string };

type Gate = ({ ok: true; remaining: number } | { ok: false; reason: "capped" | "off" | "unavailable"; cause: string }) & { until: number };

/** Gates by chat, in this object's memory: one chat's decides are one object's, so its count stays close. */
const gates = new Map<string, Gate>();
const keyOf = (who: Metered) => (who.style === "direct" ? `d:${who.sender}` : `g:${who.line}:${who.chat}`);
const whoOf = (who: Metered): Metered => ({ chat: who.chat, style: who.style, ...(who.line !== undefined ? { line: who.line } : {}), ...(who.sender !== undefined ? { sender: who.sender } : {}) });

/** For tests: forget every kept gate. */
export function forgetGates(): void {
  gates.clear();
}

async function askGate(deps: MeterDeps, who: Metered, now: number, timeoutMs: number): Promise<Gate | null> {
  try {
    const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/decide/gate`, deps.workerSecret, whoOf(who), timeoutMs);
    const body = record(json);
    if (status !== 200) return null;
    if (body.ok === true && typeof body.remaining === "number" && Number.isFinite(body.remaining)) return { ok: true, remaining: body.remaining, until: now + GATE_FOR_MS };
    if (body.ok === false) {
      const reason = body.reason === "capped" || body.reason === "off" ? body.reason : "unavailable";
      const cause = typeof body.cause === "string" ? body.cause.replace(/[^\w-]/g, "").slice(0, 40) || "unknown" : "unknown";
      return { ok: false, reason, cause, until: now + REFUSED_FOR_MS };
    }
    return null;
  } catch {
    return null;
  }
}

/** The chat's gate: kept, kept but old (refreshed beside), or asked now. Null when the control plane cannot say. */
async function gateFor(deps: MeterDeps, who: Metered, timeoutMs: number): Promise<Gate | null> {
  const now = deps.now?.() ?? Date.now();
  const key = keyOf(who);
  const kept = gates.get(key);
  if (kept !== undefined && kept.until > now) return kept;
  const fresh = askGate(deps, who, now, timeoutMs).then((gate) => {
    // A group not set up yet (`no_group`) is being set up by the turn this text starts: never kept, so its next text
    // asks again and gets the judge (2026-11-12: every new group's first texts got no tapback for a minute).
    if (gate !== null && !(gate.ok === false && gate.cause === NOT_SET_UP)) gates.set(key, gate);
    else if (gate !== null) gates.delete(key);
    return gate;
  });
  if (kept !== undefined) {
    // Old: used for this text, and a fresh one asked beside it.
    (deps.waitUntil ?? ((work) => void work.catch(() => {})))(fresh);
    return kept;
  }
  return await fresh;
}

type Report = { calls: number; failed: number; refused: number; questions: number; chars: number; ms: number };

/** What was decided, to the control plane after the answer: never waited on, never words. */
function report(deps: MeterDeps, who: Metered, counts: Report): void {
  const sent = post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/decide/usage`, deps.workerSecret, { ...whoOf(who), ...counts }).catch(() => {
    console.log(JSON.stringify({ event: "decide_usage_unreported" }));
  });
  (deps.waitUntil ?? ((work) => void work.catch(() => {})))(sent);
}

/**
 * Ask the gateway `url` with `body`, under the chat's gate. The answer's JSON, or a refusal as decide answers one,
 * or null when the gateway or the gate could not be reached (the caller asks the control plane instead).
 */
export async function askGateway(deps: MeterDeps, url: string, who: Metered, body: unknown, timeoutMs: number): Promise<{ json: Record<string, unknown> } | { refused: { reason: "capped" | "off" | "unavailable"; cause: string } } | { timedOut: true } | null> {
  const binding = deps.texts?.binding;
  if (binding === undefined) return null;
  const started = Date.now();
  const gate = await gateFor(deps, who, timeoutMs);
  if (gate === null) return null;
  const zero = { calls: 0, failed: 0, refused: 0, questions: 0, chars: 0, ms: 0 };
  if (!gate.ok || gate.remaining <= 0) {
    report(deps, who, { ...zero, refused: 1 });
    return { refused: gate.ok ? { reason: "capped", cause: "daily_cap" } : { reason: gate.reason, cause: gate.cause } };
  }
  const left = Math.max(1, timeoutMs - (Date.now() - started));
  let reply: { status: number; json: unknown };
  try {
    reply = await post((input, init) => binding.fetch(String(input), init), "gateway", url, "", body, left);
  } catch {
    // Out of time: the control plane would only be slower. Anything else: it is asked instead.
    return Date.now() - started >= timeoutMs - 50 ? { timedOut: true } : null;
  }
  if (reply.status !== 200) return null;
  const json = record(reply.json);
  const meter = record(json.meter);
  const answered = meter.answered === true;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
  // Counted as `withJev` counts: an answered call uses one of the day's, a failed one is counted and uses none.
  if (answered) gate.remaining -= 1;
  report(deps, who, { ...zero, calls: answered ? 1 : 0, failed: answered ? 0 : 1, questions: answered ? n(meter.questions) : 0, chars: answered ? n(meter.chars) : 0, ms: n(meter.ms) });
  return { json };
}
