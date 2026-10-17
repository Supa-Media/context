/**
 * The texting Worker's half of Tex's check-in
 * (`docs/decisions/texting-assistant/heartbeat.md`).
 *
 *     Cron, every minute
 *       │
 *       ├─▶ control plane: whose check-in is due? (each with its own grant and phones)
 *       ├─▶ gateway /agent {heartbeat}: look, as that person; a text or nothing
 *       │     (or, flagged `attention`, the pings their agents asked for, as they are)
 *       ├─▶ SenderInbox for each of their phones: text it, in the chat it last texted from
 *       └─▶ control plane: the outcome, as a code
 *
 * The text goes from the gateway to the person's own phone through here and
 * nowhere else; the control plane hears a code. Logs carry the run id, the
 * outcome and counts, never the text, the grant or a phone.
 */

import { ServiceError, post, record, type Fetch } from "./clients";
import type { PhoneTexted } from "./routines";

/** How a check-in ended, as the control plane records it. */
export type HeartbeatOutcome =
  | "texted"
  | "quiet"
  | "nothing_new"
  | "paused"
  | "no_chat"
  | "failed"
  | "daily_limit"
  | "no_provider";

/** `attention`: a claim for the pings the person's agents asked for, which the gateway texts as they are, with no look. */
export type DueHeartbeat = {
  runId: string;
  accessToken: string;
  timeZone: string;
  since: number | null;
  phones: string[];
  attention: boolean;
};

/** What the gateway's look came to: a text to send, or an outcome with nothing to say. */
export type Looked = { outcome: "speak"; answer: string } | { outcome: Exclude<HeartbeatOutcome, "texted" | "no_chat"> };

/** A look reads a few notes and may take several rounds; the gateway bounds each one. */
const HEARTBEAT_TIMEOUT_MS = 180_000;
/** Check-ins worked on at once in one tick. */
export const HEARTBEAT_CONCURRENCY = 2;
const MAX_DUE_HEARTBEATS = 50;
const MAX_PHONES = 10;

const SILENT = new Set(["quiet", "nothing_new", "paused"]);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export type HeartbeatDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string | undefined;
  workerSecret: string | undefined;
  gatewayOrigin: string | undefined;
  /** Text one phone, through that phone's own inbox. */
  textPhone: (phone: string, text: string, idempotencyKey: string) => Promise<PhoneTexted>;
  log: (entry: Record<string, unknown>) => void;
};

/** The check-ins due now. A malformed one is dropped, never guessed at. */
export async function fetchDueHeartbeats(fetcher: Fetch, origin: string, secret: string): Promise<DueHeartbeat[]> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/heartbeats/due`, secret, {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const beats = record(json).heartbeats;
  if (!Array.isArray(beats)) throw new ServiceError("control_plane", status);
  const due: DueHeartbeat[] = [];
  for (const value of beats.slice(0, MAX_DUE_HEARTBEATS)) {
    const beat = record(value);
    if (!nonEmpty(beat.runId) || !nonEmpty(beat.accessToken) || typeof beat.timeZone !== "string") continue;
    const phones = Array.isArray(beat.phones) ? beat.phones.filter(nonEmpty).slice(0, MAX_PHONES) : [];
    const since = typeof beat.since === "number" && Number.isFinite(beat.since) ? beat.since : null;
    due.push({ runId: beat.runId, accessToken: beat.accessToken, timeZone: beat.timeZone, since, phones, attention: beat.attention === true });
  }
  return due;
}

/** Look once on the gateway's `/agent` with the check-in's own grant. Never throws: anything unreadable is `failed`. */
export async function runHeartbeat(fetcher: Fetch, gatewayOrigin: string, beat: DueHeartbeat): Promise<Looked> {
  let result: { status: number; json: unknown };
  try {
    result = await post(
      fetcher,
      "gateway",
      `${gatewayOrigin}/agent`,
      beat.accessToken,
      { heartbeat: { timeZone: beat.timeZone, since: beat.since, ...(beat.attention ? { attention: true } : {}) } },
      HEARTBEAT_TIMEOUT_MS,
    );
  } catch {
    return { outcome: "failed" };
  }
  const body = record(result.json);
  if (result.status === 200) {
    if (body.outcome === "speak" && typeof body.answer === "string" && body.answer.trim() !== "") {
      return { outcome: "speak", answer: body.answer };
    }
    if (typeof body.outcome === "string" && SILENT.has(body.outcome)) return { outcome: body.outcome as "quiet" };
    return { outcome: "failed" };
  }
  if (result.status === 409) return { outcome: "no_provider" };
  if (result.status === 429) return { outcome: "daily_limit" };
  return { outcome: "failed" };
}

async function runOne(beat: DueHeartbeat, deps: HeartbeatDeps, gateway: string): Promise<{ outcome: HeartbeatOutcome; texted: number }> {
  const looked = await runHeartbeat(deps.fetch, gateway, beat);
  if (looked.outcome !== "speak") return { outcome: looked.outcome, texted: 0 };
  const results: PhoneTexted[] = [];
  for (const phone of beat.phones) {
    try {
      results.push(await deps.textPhone(phone, looked.answer, `heartbeat:${beat.runId}:${phone}`));
    } catch {
      results.push("failed");
    }
  }
  const texted = results.filter((result) => result === "texted").length;
  if (texted > 0) return { outcome: "texted", texted };
  return { outcome: results.includes("failed") ? "failed" : "no_chat", texted: 0 };
}

/** One tick: check in for everyone due, a couple at a time. Never throws. */
export async function runDueHeartbeats(deps: HeartbeatDeps): Promise<void> {
  const set = (value: string | undefined): value is string => typeof value === "string" && value.trim() !== "";
  if (!set(deps.controlPlaneOrigin) || !set(deps.workerSecret) || !set(deps.gatewayOrigin)) return;
  const origin = deps.controlPlaneOrigin;
  const secret = deps.workerSecret;
  const gateway = deps.gatewayOrigin;

  let due: DueHeartbeat[];
  try {
    due = await fetchDueHeartbeats(deps.fetch, origin, secret);
  } catch (error) {
    deps.log({ event: "heartbeats_due", error: "unreachable", status: (error as ServiceError).status ?? null });
    return;
  }
  if (due.length === 0) return;
  deps.log({ event: "heartbeats_due", heartbeats: due.length });

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const beat = due[next++]!;
      const started = Date.now();
      let ran: { outcome: HeartbeatOutcome; texted: number } = { outcome: "failed", texted: 0 };
      try {
        ran = await runOne(beat, deps, gateway);
      } catch {
        // `runOne` does not throw; a surprise is still owed an outcome.
      }
      deps.log({ event: "heartbeat_run", run: beat.runId, outcome: ran.outcome, texted: ran.texted, ms: Date.now() - started });
      try {
        const { status } = await post(deps.fetch, "control_plane", `${origin}/agent-texts/heartbeats/result`, secret, {
          runId: beat.runId,
          outcome: ran.outcome,
        });
        if (status < 200 || status >= 300) throw new ServiceError("control_plane", status);
      } catch (error) {
        deps.log({ event: "heartbeat_result", run: beat.runId, error: "unreachable", status: (error as ServiceError).status ?? null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEARTBEAT_CONCURRENCY, due.length) }, worker));
}
