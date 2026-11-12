import { AGENT_TIMEOUT_MS, post, record, ServiceError, type Fetch } from "./clients";

// ── Routines ──────────────────────────────────────────────────────────────
//
// A routine is a note the control plane says is due (`docs/decisions/
// routines.md`). The control plane hands this Worker the runs and a grant for
// each; the gateway runs it; the answer comes back here and goes out as texts.
// The answer never passes through the control plane: what this Worker reports
// back is an outcome code and a count.

/** How a routine's run ended, as the control plane records it. */
export type RoutineOutcome =
  | "answered"
  | "skipped"
  | "finished"
  | "failed"
  | "paused"
  | "routine_gone"
  | "not_a_routine"
  | "daily_limit"
  | "no_provider"
  | "no_chat";

export type RoutineSend = "text" | "note" | "both";

export type DueRoutine = {
  runId: string;
  /** "" for a chat routine's run: the chat's own turn mints its grant (`groupRoutines.ts`). */
  accessToken: string;
  path: string;
  timeZone: string;
  send: RoutineSend;
  phones: string[];
  /** A chat routine's chat, by its key: answered into that group, never a phone. */
  chat?: string;
  /** A chat routine's last run, in ms: what "new" means to it (`wake: new mail`). */
  since?: number;
  /** When this routine runs next after this run (`null` when paused). */
  nextRunAt?: number | null;
};

/** Most runs one tick takes on; the rest are still due on the next. */
export const MAX_DUE_RUNS = 100;
const E164 = /^\+[1-9]\d{6,14}$/;

const isSend = (value: unknown): value is RoutineSend => value === "text" || value === "note" || value === "both";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The runs due now (the cron's), or with `scope` the one routine an alarm asks for. A malformed run is dropped, never guessed at. */
export async function fetchDueRoutines(fetcher: Fetch, origin: string, secret: string, scope?: { workspaceId: string; path: string }): Promise<DueRoutine[]> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/routines/due`, secret, scope ? { scope } : {});
  if (status !== 200) throw new ServiceError("control_plane", status);
  const runs = record(json).runs;
  if (!Array.isArray(runs)) throw new ServiceError("control_plane", status);
  const due: DueRoutine[] = [];
  for (const value of runs.slice(0, MAX_DUE_RUNS)) {
    const run = record(value);
    const chat = typeof run.chat === "string" && /^[0-9a-f]{64}$/.test(run.chat) ? run.chat : undefined;
    if (!nonEmpty(run.runId) || (chat === undefined && !nonEmpty(run.accessToken)) || !nonEmpty(run.path) ||
        typeof run.timeZone !== "string" || !isSend(run.send) || !Array.isArray(run.phones)) {
      continue;
    }
    // A phone names a Durable Object, so only a well-formed number is one.
    const phones = [...new Set(run.phones.filter((phone): phone is string => typeof phone === "string" && E164.test(phone)))];
    due.push({
      runId: run.runId,
      accessToken: chat === undefined ? (run.accessToken as string) : "",
      path: run.path,
      timeZone: run.timeZone,
      send: run.send,
      phones,
      ...(chat === undefined ? {} : { chat }),
      ...(chat !== undefined && Number.isSafeInteger(run.since) && (run.since as number) > 0 ? { since: run.since as number } : {}),
      ...(typeof run.nextRunAt === "number" || run.nextRunAt === null ? { nextRunAt: run.nextRunAt as number | null } : {}),
    });
  }
  return due;
}

/** What became of a run: a code and a count, never its text. */
export async function reportRoutineResult(
  fetcher: Fetch,
  origin: string,
  secret: string,
  result: { runId: string; outcome: RoutineOutcome; texted: number },
): Promise<void> {
  const { status } = await post(fetcher, "control_plane", `${origin}/agent-texts/routines/result`, secret, {
    runId: result.runId,
    outcome: result.outcome,
    texted: result.texted,
  });
  if (status < 200 || status >= 300) throw new ServiceError("control_plane", status);
}

export type RoutineAnswer = {
  outcome: Exclude<RoutineOutcome, "no_chat">;
  /** The text to send, when the outcome is one that has something to say. */
  answer: string;
  /** The routine's `send:` as the gateway read it just now, when it said. */
  send: RoutineSend | null;
  /** What the gateway wrote to their texts for it, sealed for the next text (`warm.ts` `keepBeside`). */
  beside?: string;
};

const GATEWAY_OUTCOMES = new Set(["answered", "skipped", "finished", "failed", "paused"]);

/**
 * Run one routine on the gateway's `/agent` with its own grant. The gateway
 * re-reads the note and decides whether it runs; this only reads the result.
 * Never throws: anything it cannot read is `failed`.
 */
export async function runRoutine(
  fetcher: Fetch,
  gatewayOrigin: string,
  accessToken: string,
  routine: { path: string; timeZone: string },
): Promise<RoutineAnswer> {
  const failed: RoutineAnswer = { outcome: "failed", answer: "", send: null };
  let result: { status: number; json: unknown };
  try {
    result = await post(fetcher, "gateway", `${gatewayOrigin}/agent`, accessToken, { routine: { path: routine.path, timeZone: routine.timeZone } }, AGENT_TIMEOUT_MS);
  } catch {
    return failed;
  }
  const body = record(result.json);
  if (result.status === 200) {
    if (typeof body.outcome !== "string" || !GATEWAY_OUTCOMES.has(body.outcome)) return failed;
    const outcome = body.outcome as RoutineAnswer["outcome"];
    const speaks = outcome === "answered" || outcome === "finished";
    return {
      outcome,
      answer: speaks && typeof body.answer === "string" ? body.answer.trim() : "",
      send: isSend(body.send) ? body.send : null, ...(typeof body.beside === "string" ? { beside: body.beside } : {}), // what it wrote to their texts, sealed (`warm.ts` `keepBeside`)
    };
  }
  if (result.status === 404) return { ...failed, outcome: "routine_gone" };
  if (result.status === 400 && body.error === "not_a_routine") return { ...failed, outcome: "not_a_routine" };
  if (result.status === 409) return { ...failed, outcome: "no_provider" };
  if (result.status === 429) return { ...failed, outcome: "daily_limit" };
  return failed;
}
