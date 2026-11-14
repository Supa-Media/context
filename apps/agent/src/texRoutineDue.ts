/**
 * The routine a Tex store's alarm asks for, run now: the named RPC entrypoint
 * `TexRoutines.routineDue({owner, id})` (`apps/mcp/src/texStore/dispatch.js`
 * calls it through the gateway's `TEXTING` binding, with `entrypoint`).
 *
 * A named entrypoint is reachable only through a service binding that names
 * it, never over HTTP, so there is no route and no bearer: the Worker's public
 * `fetch` does not know this method exists. The owner is `person:<workspace
 * id>` and the id the routine's path in it. A chat's owner is refused: a
 * chat's routines run on the cron, and an alarm for one would be answered by
 * nothing.
 *
 * Answers `{next}`: when the routine runs next (`null` when nothing is due now
 * or it is paused), so the object re-arms its alarm. A control plane that
 * cannot be reached rejects, so the object tries again.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { runScopedRoutine, textPhone, type RoutineDeps, type RoutineScope } from "./routines";
import { inboxForPageChat, readPageChat, readPageSteer, type PageJobs } from "./texPage";
import { readMailDelivery } from "./jobMail";
import { inboxByName } from "./objectPlace";
import { chatMove as moveChat } from "./gatewayMove";

/** A person's owner is their personal workspace's id, as the gateway names its Tex store. */
const PERSON_OWNER = /^person:([A-Za-z0-9_-]{1,128})$/;

/** The Worker's bindings the entrypoint reads. */
export type TexRoutineEnv = {
  CONTROL_PLANE_ORIGIN: string;
  AGENT_WORKER_SECRET: string;
  GATEWAY_ORIGIN: string;
  SENDER_INBOX: DurableObjectNamespace;
};

export class TexRoutines extends WorkerEntrypoint<TexRoutineEnv> {
  /** Runs the routine an alarm names; rejects a call that names no person's routine (`TypeError`). */
  async routineDue(call: { owner?: unknown; id?: unknown } | null): Promise<{ next: number | null }> {
    const scope = scopeOf(call);
    if (scope === null) throw new TypeError("an alarm names a person's owner and a routine path");
    return await runScopedRoutine(this.deps(), scope);
  }

  /** Moves a chat's inbox out to the gateway, or takes it back (`gatewayMove.ts`); rejects a name that never moves (`TypeError`). */
  async chatMove(call: { inbox: string; op: "out" | "back" }): Promise<{ status: number; body: unknown }> {
    return await moveChat(this.env.SENDER_INBOX, call);
  }

  /** The Tex page's view of a chat's jobs (`texPage.ts`); rejects a chat that names neither a phone nor a group key (`TypeError`). */
  async pageJobs(call: { chat?: unknown } | null): Promise<PageJobs> {
    const chat = readPageChat(call?.chat);
    if (chat === null) throw new TypeError("a page names a chat by its phone or its group key");
    const inbox = await inboxForPageChat(this.env, chat);
    if (inbox === null) return { now: Date.now(), jobs: [] };
    const response = await inbox.fetch("https://inbox/page-jobs", { method: "POST" });
    if (!response.ok) throw new Error("the chat's inbox did not answer");
    return (await response.json()) as PageJobs;
  }

  /** Steers one of a chat's jobs for a page (`texPage.ts`); `taken` is false for a job the chat does not list. */
  async pageSteer(call: { chat?: unknown; id?: unknown; text?: unknown; stop?: unknown } | null): Promise<{ taken: boolean }> {
    const chat = readPageChat(call?.chat);
    const steer = readPageSteer(call);
    if (chat === null || steer === null) throw new TypeError("a steer names a chat, a job id and its text or a stop");
    const inbox = await inboxForPageChat(this.env, chat);
    if (inbox === null) return { taken: false };
    const response = await inbox.fetch("https://inbox/page-steer", { method: "POST", body: JSON.stringify(steer) });
    if (!response.ok) throw new Error("the chat's inbox did not answer");
    return { taken: ((await response.json()) as { taken?: unknown }).taken === true };
  }

  /**
   * Note mail for one job, the moment it was sent (`jobMail.ts`,
   * `apps/mcp/src/mail/deliver.js`): handed to the job's own object, which
   * steers it into the part running now. `taken` is false once the job has
   * ended; the line is in the note either way.
   */
  async mailDeliver(call: unknown): Promise<{ taken: boolean }> {
    const delivery = readMailDelivery(call);
    if (delivery === null) throw new TypeError("a delivery names a job, its mailbox and one mail line");
    const job = inboxByName(this.env.SENDER_INBOX, `job:${delivery.jobId}`);
    const response = await job.fetch("https://inbox/job-mail", { method: "POST", body: JSON.stringify(delivery) });
    if (!response.ok) return { taken: false };
    return { taken: ((await response.json()) as { taken?: unknown }).taken === true };
  }

  private deps(): RoutineDeps {
    const env = this.env;
    return {
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
      workerSecret: env.AGENT_WORKER_SECRET,
      gatewayOrigin: env.GATEWAY_ORIGIN,
      textPhone: (phone, text, idempotencyKey, continues, beside) => textPhone(env, phone, text, idempotencyKey, continues, beside),
      log: (entry) => console.log(JSON.stringify(entry)),
    };
  }
}

function scopeOf(call: { owner?: unknown; id?: unknown } | null): RoutineScope | null {
  if (typeof call !== "object" || call === null) return null;
  const { owner, id } = call;
  if (typeof owner !== "string" || typeof id !== "string") return null;
  if (id.length === 0 || id.length > 1024 || id.includes("\0")) return null;
  const match = PERSON_OWNER.exec(owner);
  if (match === null) return null;
  return { workspaceId: match[1]!, path: id };
}
