/**
 * The texting Worker's half of routines (`docs/decisions/routines.md`).
 *
 *     Cron, every minute
 *       │
 *       ├─▶ control plane: which runs are due? (each with its own grant)
 *       ├─▶ gateway /agent {routine}: run it, as its writer
 *       ├─▶ SenderInbox for each phone: text the answer to the chat it
 *       │                               last texted from
 *       └─▶ control plane: the outcome and how many phones were texted
 *
 * This Worker pulls; nothing calls it, so it needs no new secret. The answer
 * goes from the gateway to the phone through here and nowhere else: the
 * control plane hears an outcome code and a count. Linq's line reaches only
 * people who texted it first, so a phone with no remembered chat is not
 * texted, and a run that needed a text and reached nobody is `no_chat`.
 *
 * Logs carry the run id, the outcome and counts. Never the answer, the grant,
 * the path or a phone number.
 */

import {
  fetchDueRoutines,
  reportRoutineResult,
  runRoutine,
  sendLinqText,
  type DueRoutine,
  type Fetch,
  type RoutineOutcome,
} from "./clients";
import { textsFromAnswer } from "./format";
import { CHAT_KEY, type InboxStorage, type RememberedChat } from "./inbox";
import { record } from "./simulator";

/** Runs worked on at once in one tick. */
export const ROUTINE_CONCURRENCY = 4;

/** What texting one phone came to. `failed` is a send that was refused. */
export type PhoneTexted = "texted" | "no_chat" | "failed";

export type RoutineDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string | undefined;
  workerSecret: string | undefined;
  gatewayOrigin: string | undefined;
  /** Text one phone the answer, through that phone's own inbox. */
  textPhone: (phone: string, text: string, idempotencyKey: string) => Promise<PhoneTexted>;
  log: (entry: Record<string, unknown>) => void;
};

const set = (value: string | undefined): value is string => typeof value === "string" && value.trim() !== "";

/** One tick: run everything due, a few at a time. Never throws. */
export async function runDueRoutines(deps: RoutineDeps): Promise<void> {
  if (!set(deps.controlPlaneOrigin) || !set(deps.workerSecret) || !set(deps.gatewayOrigin)) {
    deps.log({ event: "routines_due", skipped: "unconfigured" });
    return;
  }
  const origin = deps.controlPlaneOrigin;
  const secret = deps.workerSecret;
  const gateway = deps.gatewayOrigin;

  let due: DueRoutine[];
  try {
    due = await fetchDueRoutines(deps.fetch, origin, secret);
  } catch (error) {
    deps.log({ event: "routines_due", error: "unreachable", status: statusOf(error) });
    return;
  }
  if (due.length === 0) return;
  deps.log({ event: "routines_due", runs: due.length });

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const run = due[next++];
      try {
        await runOne(run, deps, origin, secret, gateway);
      } catch {
        // One run's surprise is not the others' problem, and it is still owed
        // an outcome, so the control plane does not wait on it.
        deps.log({ event: "routine_run", run: run.runId, error: "unexpected" });
        await reportRoutineResult(deps.fetch, origin, secret, { runId: run.runId, outcome: "failed", texted: 0 }).catch(
          () => undefined,
        );
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ROUTINE_CONCURRENCY, due.length) }, worker));
}

async function runOne(run: DueRoutine, deps: RoutineDeps, origin: string, secret: string, gateway: string) {
  const started = Date.now();
  const ran = await runRoutine(deps.fetch, gateway, run.accessToken, { path: run.path, timeZone: run.timeZone });

  // The gateway read the note just now; its `send:` is the current one.
  const send = ran.send ?? run.send;
  const speaks = (ran.outcome === "answered" || ran.outcome === "finished") && ran.answer !== "";
  const needsText = speaks && (send === "text" || send === "both");

  let outcome: RoutineOutcome = ran.outcome;
  let texted = 0;
  if (needsText) {
    const results: PhoneTexted[] = [];
    for (const phone of run.phones) {
      try {
        results.push(await deps.textPhone(phone, ran.answer, `routine:${run.runId}:${phone}`));
      } catch {
        results.push("failed");
      }
    }
    texted = results.filter((result) => result === "texted").length;
    if (texted === 0) outcome = results.includes("failed") ? "failed" : "no_chat";
  }

  deps.log({
    event: "routine_run",
    run: run.runId,
    outcome,
    texted,
    phones: needsText ? run.phones.length : 0,
    ms: Date.now() - started,
  });
  try {
    await reportRoutineResult(deps.fetch, origin, secret, { runId: run.runId, outcome, texted });
  } catch (error) {
    deps.log({ event: "routine_result", run: run.runId, error: "unreachable", status: statusOf(error) });
  }
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

// ── The Durable Object's side ─────────────────────────────────────────────

export type RoutineTextDeps = {
  fetch: Fetch;
  linqApiKey: string;
  now: () => number;
  /** Whether the staging simulator is on; a simulated chat is texted only then. */
  simulator: boolean;
};

/**
 * Text this sender a routine's answer, in the chat they last texted from,
 * split the way a reply is. Nothing is stored: the answer exists here only
 * for as long as the send takes.
 */
export async function textRoutine(
  storage: InboxStorage,
  body: { text: string; idempotencyKey: string },
  deps: RoutineTextDeps,
): Promise<PhoneTexted> {
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  if (!chat || typeof chat.chatId !== "string" || chat.chatId === "") return "no_chat";
  const texts = textsFromAnswer(body.text);
  if (chat.channel === "simulator") {
    if (!deps.simulator) return "no_chat";
    for (const text of texts) await record(storage, "in", text, deps.now());
    return "texted";
  }
  let sent = 0;
  try {
    for (const [index, text] of texts.entries()) {
      await sendLinqText(
        deps.fetch,
        deps.linqApiKey,
        chat.chatId,
        text,
        index === 0 ? body.idempotencyKey : `${body.idempotencyKey}:${index}`,
      );
      sent++;
    }
  } catch {
    // The first text is the answer; a link that followed it failing does
    // not un-text the person.
    return sent > 0 ? "texted" : "failed";
  }
  return "texted";
}
