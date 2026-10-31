/**
 * `POST /tex/routine-due`: a Tex store's alarm asks for one routine to run now
 * (`apps/mcp/src/texStore.js`, dispatch). The body is `{owner, id}`: the owner
 * is `person:<workspace id>` and the id is the routine's path in it.
 *
 * Reached through the gateway's service binding, and checked again here: the
 * route needs `TEX_ALARM_SECRET` as its bearer, and refuses everything while
 * none is configured. A chat's owner is refused: a chat's routines run on the
 * cron, and an alarm for one would be answered by nothing.
 *
 * Answers `{next}`: when the routine runs next (`null` when nothing is due now
 * or it is paused), so the object re-arms its alarm. A control plane that
 * cannot be reached is a 503, so the object tries again.
 */

import { bearerMatches } from "./newLine";
import { runScopedRoutine, type RoutineDeps, type RoutineScope } from "./routines";

export const TEX_ROUTINE_DUE_PATH = "/tex/routine-due";

/** A person's owner is their personal workspace's id, as the gateway names its Tex store. */
const PERSON_OWNER = /^person:([A-Za-z0-9_-]{1,128})$/;

/** The Worker's bindings this route reads. */
export type TexRoutineEnv = {
  TEX_ALARM_SECRET?: string;
  CONTROL_PLANE_ORIGIN: string;
  AGENT_WORKER_SECRET: string;
  GATEWAY_ORIGIN: string;
};

/**
 * @param textPhone the Worker's own way to text one phone (`index.ts`)
 */
export async function texRoutineDue(
  request: Request,
  env: TexRoutineEnv,
  textPhone: RoutineDeps["textPhone"],
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const secret = env.TEX_ALARM_SECRET;
  if (!secret || !(await bearerMatches(secret, request.headers.get("authorization")))) {
    return new Response(null, { status: 401 });
  }
  const scope = scopeOf(await request.json().catch(() => null));
  if (scope === null) return new Response(null, { status: 400 });
  try {
    const deps: RoutineDeps = {
      fetch: (input, init) => fetch(input, init),
      controlPlaneOrigin: env.CONTROL_PLANE_ORIGIN,
      workerSecret: env.AGENT_WORKER_SECRET,
      gatewayOrigin: env.GATEWAY_ORIGIN,
      textPhone,
      log: (entry) => console.log(JSON.stringify(entry)),
    };
    return Response.json(await runScopedRoutine(deps, scope));
  } catch {
    return new Response(null, { status: 503 });
  }
}

function scopeOf(body: unknown): RoutineScope | null {
  if (typeof body !== "object" || body === null) return null;
  const { owner, id } = body as Record<string, unknown>;
  if (typeof owner !== "string" || typeof id !== "string") return null;
  if (id.length === 0 || id.length > 1024 || id.includes("\0")) return null;
  const match = PERSON_OWNER.exec(owner);
  if (match === null) return null;
  return { workspaceId: match[1]!, path: id };
}
