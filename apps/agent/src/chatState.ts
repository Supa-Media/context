/**
 * A chat's conversation state, one per chat's Durable Object (Jhonatan,
 * 2026-11-01; docs/decisions/texting-assistant/chat-state-machine.md).
 *
 *   idle -> gathering -> drafting -> sending -> idle
 *
 * - idle: nothing waits on Tex.
 * - gathering: decide said wait N seconds on a burst still being typed; the
 *   chat's alarm decides again when the wait ends, or at once when a new
 *   message lands (`version` moved).
 * - drafting: one model turn is writing (the one-turn-at-a-time rule).
 * - sending: its parts are going out.
 *
 * Guards that keep a model from looping: at most `MAX_CHAT_WAITS` waits per
 * burst, never past `BURST_DEADLINE_MS` after the burst's first message, and
 * at most `MAX_REDRAFTS` redrafts (a restart, or a draft the recheck held) per
 * burst. A refused transition is logged (`chat_state_refused`) and the caller
 * takes the safe road: answer now, or send the draft as written.
 *
 * Beside these phases, and never blocked by them: the code fast path
 * (commands, menu replies, the style question: `groupBeside.ts`), a held ask
 * waiting for the asker's yes (`gask`, `thumbs.ts`), a muted or unbound chat
 * and an SMS group (answered by the control plane's status, `answerGroup`),
 * the newcomer hold (a reply held when someone joined mid-turn), and a turn
 * whose workflow could not start (`groupTurnRun.ts` `stuck`). Each ends the
 * phase it ran in through `done` or `failed`.
 */
import type { InboxStorage } from "./inbox";

export type ChatPhase = "idle" | "gathering" | "drafting" | "sending";
/** `cancelled`: a restart stopped the turn; its burst (and its redraft count) goes on into the next turn. */
export type ChatEvent = "message" | "wait" | "start" | "silent" | "redraft" | "send" | "cancelled" | "done" | "failed";
export type ChatState = {
  phase: ChatPhase;
  /** Bumped by every message the chat takes in: a draft or a wait knows whether the chat moved since it began. */
  version: number;
  /** When the first message of the burst Tex owes an answer to came in. */
  burstAt?: number;
  /** While gathering: when the wait ends, and the version it began at. */
  until?: number;
  gatheredAt?: number;
  waits: number;
  redrafts: number;
};

export const CHAT_STATE_KEY = "gstate";
export const MAX_CHAT_WAITS = 2;
/** However often decide says wait, the burst is answered this soon after its first message. */
export const BURST_DEADLINE_MS = 8_000;
export const MAX_WAIT_SECONDS = 8;
export const MAX_REDRAFTS = 3;

const IDLE: ChatState = { phase: "idle", version: 0, waits: 0, redrafts: 0 };

/** Which phase each event leads to from each phase; anything missing is refused. */
const NEXT: Record<ChatPhase, Partial<Record<ChatEvent, ChatPhase>>> = {
  idle: { message: "idle", wait: "gathering", start: "drafting", silent: "idle" },
  gathering: { message: "gathering", wait: "gathering", start: "drafting", silent: "idle" },
  drafting: { message: "drafting", redraft: "drafting", send: "sending", cancelled: "idle", done: "idle", failed: "idle" },
  sending: { message: "sending", redraft: "drafting", send: "sending", cancelled: "idle", done: "idle", failed: "idle" },
};

export type StepOptions = { now: number; burst?: boolean; seconds?: number };
export type Step = { ok: true; state: ChatState } | { ok: false; reason: string };

/** Whether decide may still hold this burst: fewer than `MAX_CHAT_WAITS` waits, and before its deadline. */
export function canWait(state: ChatState, now: number): boolean {
  return state.waits < MAX_CHAT_WAITS && (state.burstAt === undefined || now < state.burstAt + BURST_DEADLINE_MS);
}

export function canRedraft(state: ChatState): boolean {
  return state.redrafts < MAX_REDRAFTS;
}

/** Whether a wait still holds the burst: gathering, not over, and no message came since it began. */
export function stillGathering(state: ChatState, now: number): boolean {
  return state.phase === "gathering" && state.until !== undefined && now < state.until && state.version === state.gatheredAt;
}

/** The next state, or why the event is refused here. Pure: `chatEvent` persists and logs it. */
export function step(state: ChatState, event: ChatEvent, { now, burst = false, seconds = 0 }: StepOptions): Step {
  const phase = NEXT[state.phase][event];
  if (phase === undefined) return { ok: false, reason: `${event}_in_${state.phase}` };
  switch (event) {
    case "message":
      return { ok: true, state: { ...state, version: state.version + 1, ...(burst && state.burstAt === undefined ? { burstAt: now } : {}) } };
    case "wait": {
      if (!canWait(state, now)) return { ok: false, reason: state.waits >= MAX_CHAT_WAITS ? "wait_cap" : "deadline" };
      const held = Math.min(MAX_WAIT_SECONDS, Math.max(0, seconds)) * 1000;
      const until = Math.min(now + held, (state.burstAt ?? now) + BURST_DEADLINE_MS);
      if (until <= now) return { ok: false, reason: "deadline" };
      return { ok: true, state: { ...state, phase, until, gatheredAt: state.version, waits: state.waits + 1, burstAt: state.burstAt ?? now } };
    }
    case "redraft":
      if (!canRedraft(state)) return { ok: false, reason: "redraft_cap" };
      return { ok: true, state: { ...state, phase, redrafts: state.redrafts + 1 } };
    case "start":
    case "send":
      return { ok: true, state: { ...state, phase, until: undefined, gatheredAt: undefined } };
    case "cancelled":
      return { ok: true, state: { ...state, phase } };
    default:
      // silent, done, failed: the burst is over.
      return { ok: true, state: { ...IDLE, version: state.version } };
  }
}

export async function readChatState(storage: InboxStorage): Promise<ChatState> {
  return (await storage.get<ChatState>(CHAT_STATE_KEY)) ?? IDLE;
}

/** Apply `event`, persist it and log the transition (codes only). Refused, the state is left as it was. */
export async function chatEvent(storage: InboxStorage, event: ChatEvent, cause: string, options: StepOptions): Promise<Step> {
  const state = await readChatState(storage);
  const next = step(state, event, options);
  if (!next.ok) {
    console.log(JSON.stringify({ event: "chat_state_refused", from: state.phase, cause: event, reason: next.reason }));
    return next;
  }
  await storage.put<ChatState>(CHAT_STATE_KEY, next.state);
  if (next.state.phase !== state.phase || event !== "message") console.log(JSON.stringify({ event: "chat_state", from: state.phase, to: next.state.phase, cause: `${event}:${cause}` }));
  return next;
}
