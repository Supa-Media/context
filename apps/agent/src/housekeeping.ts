/**
 * The texting Worker's half of Tex's daily housekeeping
 * (`docs/decisions/texting-assistant/housekeeping.md`).
 *
 *     Cron, every minute
 *       │
 *       ├─▶ control plane: whose housekeeping is due? (each with its own grant)
 *       ├─▶ gateway /agent {housekeeping}: tidy, as that person
 *       └─▶ control plane: the outcome, as a code
 *
 * Housekeeping texts nobody: what it changed, and how to put each change
 * back, goes into the person's own `tex/housekeeping/`, written by the
 * gateway. Nothing it said passes through here. Logs carry the run id, the
 * outcome, a count and a time, never a grant, a path or a phone.
 */

import { ServiceError, post, record, type Fetch } from "./clients";

/** How a run ended, as the control plane records it. */
export type HousekeepingOutcome = "tidied" | "unchanged" | "failed" | "daily_limit" | "no_provider";

export type DueHousekeeping = { runId: string; accessToken: string; timeZone: string };

/** A run reads the workspace and may take many rounds; the gateway bounds each one. */
const HOUSEKEEPING_TIMEOUT_MS = 300_000;
/** Runs worked on at once in one tick. */
export const HOUSEKEEPING_CONCURRENCY = 2;
const MAX_DUE_HOUSEKEEPING = 50;

const GATEWAY_OUTCOMES = new Set(["tidied", "unchanged"]);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export type HousekeepingDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string | undefined;
  workerSecret: string | undefined;
  gatewayOrigin: string | undefined;
  log: (entry: Record<string, unknown>) => void;
};

/** The runs due now. A malformed one is dropped, never guessed at. */
export async function fetchDueHousekeeping(fetcher: Fetch, origin: string, secret: string): Promise<DueHousekeeping[]> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/housekeeping/due`, secret, {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const runs = record(json).runs;
  if (!Array.isArray(runs)) throw new ServiceError("control_plane", status);
  const due: DueHousekeeping[] = [];
  for (const value of runs.slice(0, MAX_DUE_HOUSEKEEPING)) {
    const run = record(value);
    if (!nonEmpty(run.runId) || !nonEmpty(run.accessToken) || typeof run.timeZone !== "string") continue;
    due.push({ runId: run.runId, accessToken: run.accessToken, timeZone: run.timeZone });
  }
  return due;
}

/** Tidy once on the gateway's `/agent` with the run's own grant. Never throws: anything unreadable is `failed`. */
export async function runHousekeeping(
  fetcher: Fetch,
  gatewayOrigin: string,
  run: DueHousekeeping,
): Promise<{ outcome: HousekeepingOutcome; changes: number }> {
  let result: { status: number; json: unknown };
  try {
    result = await post(fetcher, "gateway", `${gatewayOrigin}/agent`, run.accessToken, { housekeeping: { timeZone: run.timeZone } }, HOUSEKEEPING_TIMEOUT_MS);
  } catch {
    return { outcome: "failed", changes: 0 };
  }
  const body = record(result.json);
  if (result.status === 200 && typeof body.outcome === "string" && GATEWAY_OUTCOMES.has(body.outcome)) {
    const changes = typeof body.changes === "number" && Number.isFinite(body.changes) ? body.changes : 0;
    return { outcome: body.outcome as HousekeepingOutcome, changes };
  }
  if (result.status === 409) return { outcome: "no_provider", changes: 0 };
  if (result.status === 429) return { outcome: "daily_limit", changes: 0 };
  return { outcome: "failed", changes: 0 };
}

/** One tick: keep house for everyone due, a couple at a time. Never throws. */
export async function runDueHousekeeping(deps: HousekeepingDeps): Promise<void> {
  const set = (value: string | undefined): value is string => typeof value === "string" && value.trim() !== "";
  if (!set(deps.controlPlaneOrigin) || !set(deps.workerSecret) || !set(deps.gatewayOrigin)) return;
  const origin = deps.controlPlaneOrigin;
  const secret = deps.workerSecret;
  const gateway = deps.gatewayOrigin;

  let due: DueHousekeeping[];
  try {
    due = await fetchDueHousekeeping(deps.fetch, origin, secret);
  } catch (error) {
    deps.log({ event: "housekeeping_due", error: "unreachable", status: (error as ServiceError).status ?? null });
    return;
  }
  if (due.length === 0) return;
  deps.log({ event: "housekeeping_due", runs: due.length });

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const run = due[next++]!;
      const started = Date.now();
      let ran: { outcome: HousekeepingOutcome; changes: number } = { outcome: "failed", changes: 0 };
      try {
        ran = await runHousekeeping(deps.fetch, gateway, run);
      } catch {
        // `runHousekeeping` does not throw; a surprise is still owed an outcome.
      }
      deps.log({ event: "housekeeping_run", run: run.runId, outcome: ran.outcome, changes: ran.changes, ms: Date.now() - started });
      try {
        const { status } = await post(deps.fetch, "control_plane", `${origin}/agent-texts/housekeeping/result`, secret, {
          runId: run.runId,
          outcome: ran.outcome,
        });
        if (status < 200 || status >= 300) throw new ServiceError("control_plane", status);
      } catch (error) {
        deps.log({ event: "housekeeping_result", run: run.runId, error: "unreachable", status: (error as ServiceError).status ?? null });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOUSEKEEPING_CONCURRENCY, due.length) }, worker));
}
