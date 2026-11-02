/**
 * The texting Worker's half of Tex's nightly dream
 * (`docs/decisions/texting-assistant/dreams.md`).
 *
 *     Cron, every minute
 *       │
 *       ├─▶ control plane: whose dream is due? (each with its own grant)
 *       ├─▶ gateway /agent {dream}: dream, as that person
 *       └─▶ control plane: the outcome, as a code
 *
 * A dream texts nobody: what it read, thought and changed goes into the
 * person's own `tex/dreams/` and `tex/about.md`, written by the gateway.
 * Nothing it said passes through here. Logs carry the run id, the outcome and
 * a time, never a grant or a phone.
 */

import { ServiceError, post, record, type Fetch } from "./clients";

/** How a dream ended, as the control plane records it. */
export type DreamOutcome = "dreamed" | "unchanged" | "nothing_new" | "failed" | "daily_limit" | "no_provider";

export type DueDream = { runId: string; accessToken: string; timeZone: string; since: number | null };

/** A dream reads a day of texts and may take several rounds; the gateway bounds each one. */
const DREAM_TIMEOUT_MS = 300_000;
/** Dreams worked on at once in one tick. */
export const DREAM_CONCURRENCY = 2;
const MAX_DUE_DREAMS = 50;

const GATEWAY_OUTCOMES = new Set(["dreamed", "unchanged", "nothing_new"]);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export type DreamDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string | undefined;
  workerSecret: string | undefined;
  gatewayOrigin: string | undefined;
  log: (entry: Record<string, unknown>) => void;
};

/** The dreams due now. A malformed one is dropped, never guessed at. */
export async function fetchDueDreams(fetcher: Fetch, origin: string, secret: string): Promise<DueDream[]> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/dreams/due`, secret, {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const dreams = record(json).dreams;
  if (!Array.isArray(dreams)) throw new ServiceError("control_plane", status);
  const due: DueDream[] = [];
  for (const value of dreams.slice(0, MAX_DUE_DREAMS)) {
    const dream = record(value);
    if (!nonEmpty(dream.runId) || !nonEmpty(dream.accessToken) || typeof dream.timeZone !== "string") continue;
    const since = typeof dream.since === "number" && Number.isFinite(dream.since) ? dream.since : null;
    due.push({ runId: dream.runId, accessToken: dream.accessToken, timeZone: dream.timeZone, since });
  }
  return due;
}

/** Dream once on the gateway's `/agent` with the dream's own grant. Never throws: anything unreadable is `failed`. */
export async function runDream(fetcher: Fetch, gatewayOrigin: string, dream: DueDream): Promise<DreamOutcome> {
  let result: { status: number; json: unknown };
  try {
    result = await post(
      fetcher,
      "gateway",
      `${gatewayOrigin}/agent`,
      dream.accessToken,
      { dream: { timeZone: dream.timeZone, since: dream.since } },
      DREAM_TIMEOUT_MS,
    );
  } catch {
    return "failed";
  }
  const outcome = record(result.json).outcome;
  if (result.status === 200) return typeof outcome === "string" && GATEWAY_OUTCOMES.has(outcome) ? (outcome as DreamOutcome) : "failed";
  if (result.status === 409) return "no_provider";
  if (result.status === 429) return "daily_limit";
  return "failed";
}

/** One tick: dream for everyone due, a couple at a time. Never throws. */
export async function runDueDreams(deps: DreamDeps): Promise<void> {
  const set = (value: string | undefined): value is string => typeof value === "string" && value.trim() !== "";
  if (!set(deps.controlPlaneOrigin) || !set(deps.workerSecret) || !set(deps.gatewayOrigin)) return;
  const origin = deps.controlPlaneOrigin;
  const secret = deps.workerSecret;
  const gateway = deps.gatewayOrigin;

  let due: DueDream[];
  try {
    due = await fetchDueDreams(deps.fetch, origin, secret);
  } catch (error) {
    deps.log({ event: "dreams_due", error: "unreachable", status: (error as ServiceError).status ?? null });
    return;
  }
  if (due.length === 0) return;
  deps.log({ event: "dreams_due", dreams: due.length });

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const dream = due[next++]!;
      const started = Date.now();
      let outcome: DreamOutcome = "failed";
      try {
        outcome = await runDream(deps.fetch, gateway, dream);
      } catch {
        // `runDream` does not throw; a surprise is still owed an outcome.
      }
      deps.log({ event: "dream_run", run: dream.runId, outcome, ms: Date.now() - started });
      try {
        const { status } = await post(deps.fetch, "control_plane", `${origin}/agent-texts/dreams/result`, secret, {
          runId: dream.runId,
          outcome,
        });
        if (status < 200 || status >= 300) throw new ServiceError("control_plane", status);
      } catch (error) {
        deps.log({ event: "dream_result", run: dream.runId, error: "unreachable", status: (error as ServiceError).status ?? null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DREAM_CONCURRENCY, due.length) }, worker));
}
