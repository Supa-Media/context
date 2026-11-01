/**
 * The Cloudflare Workflow that sees one group turn through (`groupTurnRun.ts`
 * says what stays in the chat's object and why). One instance per turn, named
 * by the turn's id, so starting the same turn twice is refused rather than
 * answered twice.
 *
 * Step "answer" asks the chat's object to answer the turn. It throws on
 * anything but a 2xx, so Workflows retries it: three more times, from ten
 * seconds with exponential backoff (Dev2, 2026-10-27). A retry sends again
 * only what did not reach the chat the first time (`groupSay.ts` `once`).
 * After the last, step "tell failed" has the object say it couldn't answer.
 */

import { logged } from "./agentError";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";

export type GroupTurnParams = { inbox: string; turn: string };
export const ANSWER_RETRIES = { limit: 3, delay: "10 seconds", backoff: "exponential" } as const;
/** Longer than one answer can take (`clients.ts` `AGENT_STREAM_TIMEOUT_MS`, twelve minutes). */
export const ANSWER_TIMEOUT = "20 minutes";

/** Asks the chat's object at an internal path, with the turn's id. */
export type InboxCall = (path: "/group-answer" | "/group-failed", turn: string) => Promise<Response>;

export async function runGroupTurn(params: GroupTurnParams, step: Pick<WorkflowStep, "do">, inbox: InboxCall): Promise<string> {
  try {
    return await step.do("answer", { retries: ANSWER_RETRIES, timeout: ANSWER_TIMEOUT }, () => logged("group_answer", async () => {
      const response = await inbox("/group-answer", params.turn);
      const outcome = response.ok ? ((await response.json()) as { outcome?: unknown }).outcome : undefined;
      // "failed" is the turn's own error: thrown, so Workflows retries it.
      if (outcome !== "done" && outcome !== "gone") throw new Error(`group-answer ${response.status} ${String(outcome)}`);
      return outcome;
    }));
  } catch {
    return await step.do("tell failed", () => logged("group_failed", async () => {
      const response = await inbox("/group-failed", params.turn);
      if (!response.ok) throw new Error(`group-failed ${response.status}`);
      return "failed";
    }));
  }
}

export class GroupTurnWorkflow extends WorkflowEntrypoint<Env, GroupTurnParams> {
  async run(event: Readonly<WorkflowEvent<GroupTurnParams>>, step: WorkflowStep): Promise<string> {
    const stub = this.env.SENDER_INBOX.get(this.env.SENDER_INBOX.idFromString(event.payload.inbox));
    return await runGroupTurn(event.payload, step, (path, turn) => stub.fetch(`https://inbox${path}`, { method: "POST", body: JSON.stringify({ turn }) }));
  }
}
