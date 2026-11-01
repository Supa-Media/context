/**
 * Whether, and how, Tex answers: asked of the control plane
 * (`POST /agent-texts/decide`, CONTRACT.md section 3) instead of decided here
 * by hand. The Worker still chooses which messages are put to it (a group's
 * style, `groupStyle.ts`), and still keeps every rule that is code, never the
 * model: only the asker's yes releases what was held, guests never approve,
 * a newcomer never sees earlier lines.
 *
 * Every call here fails soft. Decide unreachable or malformed is `{ ok: false }`
 * and the caller falls back to today's rules: a group answers only when
 * addressed (`addressesTex`), a person's own chat always answers.
 */

import { post, record, type Fetch } from "./clients";

export type Style = "quiet" | "attentive" | "followAlong" | "helpful" | "direct";
export type GroupStyle = Exclude<Style, "direct">;
export const GROUP_STYLES: readonly GroupStyle[] = ["quiet", "attentive", "followAlong", "helpful"];

export type Decision =
  | {
      ok: true;
      /** `wait`: a burst still being typed; decided again once it ends (`groupTurn.ts`). */
      act: "silent" | "react" | "answer" | "wait";
      covers: string[];
      midTurn?: "fold" | "queue" | "restart";
      stale: string[];
      movedOn: boolean;
      confidence: number;
      /** How long decide took, for the logs. */
      ms?: number;
      /** Decide's reaction, with any act (reacting is its own decision, Jhonatan 2026-11-01); sent only if one of `REACT_EMOJI` (`reactionFor`). */
      emoji?: string;
      /** With `wait`: the seconds decide chose; the chat's state caps the burst (`chatState.ts`). */
      waitSeconds?: number;
    }
  /** `cause`: why it was unavailable, a code for the logs (timeout, unreachable, http_<status>, bad_answer, or Convex's reason). */
  | { ok: false; reason: "capped" | "off" | "unavailable"; cause?: string; ms?: number };

export type DecideAsk = {
  chat: string;
  /** Tex's line a group is on, which keys the group's row; required for a group. */
  line?: string;
  /** Who sent the newest message, as the Worker has it; required for "direct". */
  sender?: string;
  style: Style;
  transcript: string;
  candidates: string[];
  running: boolean;
  waitingAsks: string[];
  newest: string;
};

export type ControlDeps = { fetch: Fetch; controlPlaneOrigin: string; workerSecret: string };

const unavailable = (cause: string, ms: number) => ({ ok: false, reason: "unavailable", cause, ms }) as const;
export const MAX_CANDIDATES = 32;
export const MAX_WAITING_ASKS = 8;
export const MAX_TRANSCRIPT = 24_000;
/** The unsent reply a recheck reads (Convex `MAX_DRAFT`). */
export const MAX_DRAFT = 4_000;
/** Decide on a text that came in while a turn runs is on the webhook's path: it waits no longer than a steer does. */
export const RUNNING_DECIDE_MS = 5_000;
/** Decide on what is waiting, with the person watching the typing bubble: slower than this, the fallback answers. */
export const IDLE_DECIDE_MS = 4_000;
/**
 * Decide on a group's waiting messages. Slower than this and the burst is
 * answered without it (Jhonatan, 2026-11-01: a model that is slow to decide
 * when to speak should not hold the chat; `chatState.ts`). 15 s since
 * 2026-10-27 while decide never answered; production then logged 0.7 to 2.6 s
 * per decide (2026-10-28 to 31), so 3 s, not the 1 s first asked for, which would
 * have sent three of the nine logged decides to the fallback.
 */
export const GROUP_DECIDE_MS = 3_000;
/** A caller that names no limit. */
const DEFAULT_DECIDE_MS = IDLE_DECIDE_MS;

/** Ask decide. The answer is checked like any other trust boundary: ids it names must be ones it was given. */
export async function decide(deps: ControlDeps, ask: DecideAsk, timeoutMs?: number): Promise<Decision> {
  const candidates = ask.candidates.slice(-MAX_CANDIDATES);
  const waitingAsks = ask.waitingAsks.slice(-MAX_WAITING_ASKS);
  const body = { ...ask, candidates, waitingAsks, transcript: ask.transcript.slice(-MAX_TRANSCRIPT) };
  let reply: { status: number; json: unknown };
  const started = Date.now();
  const limit = timeoutMs ?? DEFAULT_DECIDE_MS;
  try {
    reply = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/decide`, deps.workerSecret, body, limit);
  } catch {
    const ms = Date.now() - started;
    return unavailable(ms >= limit - 50 ? "timeout" : "unreachable", ms);
  }
  const ms = Date.now() - started;
  if (reply.status !== 200) return unavailable(`http_${reply.status}`, ms);
  const json = record(reply.json);
  if (json.ok === false) {
    const reason = json.reason === "capped" || json.reason === "off" ? json.reason : "unavailable";
    // Convex names the failed check in `cause` (no_group, unconfigured, model_failed, bad_answer, ...); older answers only had `reason`.
    const cause = typeof json.cause === "string" ? json.cause : typeof json.reason === "string" ? json.reason : "unknown";
    return { ok: false, reason, cause: cause.replace(/[^\w-]/g, "").slice(0, 40) || "unknown", ms };
  }
  if (json.ok !== true || (json.act !== "silent" && json.act !== "react" && json.act !== "answer" && json.act !== "wait")) return unavailable("bad_answer", ms);
  const ids = (value: unknown, allowed: readonly string[]) =>
    Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && allowed.includes(id)))] : [];
  const midTurn = json.midTurn === "fold" || json.midTurn === "queue" || json.midTurn === "restart" ? json.midTurn : undefined;
  return {
    ok: true,
    act: json.act,
    covers: ids(json.covers, candidates),
    ...(midTurn ? { midTurn } : {}),
    stale: ids(json.stale, waitingAsks),
    movedOn: json.movedOn === true,
    confidence: typeof json.confidence === "number" && Number.isFinite(json.confidence) ? Math.min(1, Math.max(0, json.confidence)) : 0,
    ms,
    // Checked against the allowlist where it is sent (`reactionFor`); here only its type.
    ...(typeof json.emoji === "string" ? { emoji: json.emoji.slice(0, 16) } : {}),
    ...(json.act === "wait" && typeof json.waitSeconds === "number" && Number.isFinite(json.waitSeconds) ? { waitSeconds: Math.min(8, Math.max(1, Math.round(json.waitSeconds))) } : {}),
  };
}

/** Whether a group answer still answers its asker (`groupRecheck.ts`): `fits` false holds it; anything unclear sends it, as before. */
export type Recheck = { ok: true; fits: boolean } | { ok: false; cause: string };

/** `POST /agent-texts/recheck` (CONTRACT.md section 3b): decide's body for a group, plus the unsent reply and the message it answers. */
export async function recheck(deps: ControlDeps, ask: Omit<DecideAsk, "running" | "waitingAsks">, draft: string, draftFor: string, timeoutMs = RUNNING_DECIDE_MS): Promise<Recheck> {
  const body = { ...ask, candidates: ask.candidates.slice(-MAX_CANDIDATES), transcript: ask.transcript.slice(-MAX_TRANSCRIPT), draft: draft.slice(0, MAX_DRAFT), draftFor };
  let reply: { status: number; json: unknown };
  try {
    reply = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/recheck`, deps.workerSecret, body, timeoutMs);
  } catch {
    return { ok: false, cause: "unreachable" };
  }
  if (reply.status !== 200) return { ok: false, cause: `http_${reply.status}` };
  const json = record(reply.json);
  if (json.ok !== true || typeof json.fits !== "boolean") return { ok: false, cause: typeof json.cause === "string" ? json.cause.replace(/[^\w-]/g, "").slice(0, 40) || "unknown" : "bad_answer" };
  return { ok: true, fits: json.fits };
}

/**
 * `POST /agent/cancel { turn }`: the running turn stops, and its held asks are
 * withdrawn. True only when the gateway says `cancelled: true`; anything else
 * (`false`: a write may have started, or there is no such turn; a missing or
 * odd field; no answer) means it runs on, and the new message waits its turn.
 */
export async function cancelTurn(deps: { fetch: Fetch; gatewayOrigin: string }, accessToken: string, turn: string): Promise<boolean> {
  try {
    const { status, json } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/cancel`, accessToken, { turn }, RUNNING_DECIDE_MS);
    return status === 200 && record(json).cancelled === true;
  } catch {
    return false;
  }
}

/** `POST /agent/stale { asks }`: asks decide says nobody is answering any more are disarmed; never extended. */
export async function staleAsks(deps: { fetch: Fetch; gatewayOrigin: string }, accessToken: string, asks: readonly string[]): Promise<boolean> {
  if (asks.length === 0) return true;
  try {
    const { status } = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/agent/stale`, accessToken, { asks }, RUNNING_DECIDE_MS);
    return status === 200;
  } catch {
    return false;
  }
}

/** `POST /agent-texts/group/engagement`: a member chose when Tex speaks up in this group. Whether it was saved. */
/** `setBy`: the chooser's handle or guest label, shown back as "set by <handle>"; never a number. */
export async function setEngagement(deps: ControlDeps, line: string, groupId: string, style: GroupStyle, setBy: string): Promise<boolean> {
  try {
    const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/group/engagement`, deps.workerSecret, {
      line,
      groupId,
      style,
      setBy,
    });
    return status === 200 && record(json).ok === true;
  } catch {
    return false;
  }
}
