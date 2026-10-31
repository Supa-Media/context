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

  private deps(): RoutineDeps {
    const env = this.env;
    return {
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
      workerSecret: env.AGENT_WORKER_SECRET,
      gatewayOrigin: env.GATEWAY_ORIGIN,
      textPhone: (phone, text, idempotencyKey) => textPhone(env, phone, text, idempotencyKey),
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
