/**
 * Tests only: drives one handed group turn as the chat's retries do (`groupRetry.ts`): answer it (`answerHanded`),
 * try again when that throws or fails, up to `ANSWER_RETRIES.limit` more times, then tell the chat it failed
 * (`failHanded`). `step` runs each named try, so a test can count them or make one throw. This was the retired
 * `group-turn` Workflow's loop (deleted 2026-11-22, part C of the runtime simplification); the chat's alarm runs the
 * same tries in production.
 */

export const ANSWER_RETRIES = { limit: 3, delay: "10 seconds", backoff: "exponential" } as const;

/** Asks the chat for a handed turn: answer it, or tell the chat it failed. */
export type InboxCall = (path: "/group-answer" | "/group-failed", turn: string) => Promise<Response>;

type Step = { do<T>(name: string, ...rest: unknown[]): Promise<T> };

export async function runGroupTurn(params: { inbox: string; turn: string }, step: Step, inbox: InboxCall): Promise<string> {
  try {
    return await step.do("answer", { retries: ANSWER_RETRIES }, async () => {
      const response = await inbox("/group-answer", params.turn);
      const outcome = response.ok ? ((await response.json()) as { outcome?: unknown }).outcome : undefined;
      if (outcome !== "done" && outcome !== "gone") throw new Error(`group-answer ${response.status} ${String(outcome)}`);
      return outcome;
    });
  } catch {
    return await step.do("tell failed", async () => {
      const response = await inbox("/group-failed", params.turn);
      if (!response.ok) throw new Error(`group-failed ${response.status}`);
      return "failed";
    });
  }
}
