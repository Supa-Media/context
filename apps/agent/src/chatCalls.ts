/**
 * What the gateway's copy of a chat object (`apps/mcp/src/texChat.js`) asks of this Worker, besides the line
 * (`lineCalls.ts`) and the move itself (`gatewayMove.ts`): the Worker's other objects it reaches by name (a job's
 * object, a chat's directory entry, a phone's inbox), the id its chat had here (the addresses of its pictures and
 * pages name it), a group turn's Workflow, which stays here and reaches the chat through that id, and a background
 * job's Workflow, which stays here too and reaches a job born in the gateway through the job stub. Called only
 * through the `TexRoutines` entrypoint, which no URL reaches.
 */

import type { GroupTurnParams } from "./groupTurnWorkflow";
import type { JobRunParams } from "./jobWorkflow";
import { inboxIdOf, objectByName } from "./objectPlace";
import { PLACED_PREFIX } from "./inboxMove";

const PLACED = /^enam:[^\0]{1,512}$/;
const NAME = /^[^\0]{1,512}$/;

/** A call to one of this Worker's placed objects, by its placed name (`enam:<name>`, as `inboxByName` names it). */
export async function inboxFetch(namespace: DurableObjectNamespace, call: { name?: unknown } | null, request: Request): Promise<Response> {
  const name = call?.name;
  if (typeof name !== "string" || !PLACED.test(name) || !name.startsWith(PLACED_PREFIX)) throw new TypeError("an object is named by its placed name");
  if (!(request instanceof Request)) throw new TypeError("a call is a Request");
  return await objectByName(namespace, name).fetch(request);
}

/** The id the chat named `name` has here: what its pictures' and pages' addresses carry (`media.ts`, `jobs.ts`). */
export function inboxId(namespace: DurableObjectNamespace, call: { name?: unknown } | null): string {
  const name = call?.name;
  if (typeof name !== "string" || !NAME.test(name)) throw new TypeError("a chat is named by its inbox name");
  return inboxIdOf(namespace, name);
}

/** Start, or find, one group turn's Workflow (`groupTurnWorkflow.ts`), as the chat object does for itself here. */
export async function groupTurn(
  workflow: Workflow<GroupTurnParams> | undefined,
  call: { op?: unknown; id?: unknown; params?: unknown } | null,
): Promise<{ ok: true }> {
  if (workflow === undefined) throw new Error("no group turn workflow here");
  const id = call?.id;
  if (typeof id !== "string" || id === "" || id.length > 200) throw new TypeError("a group turn is named by its id");
  if (call?.op === "get") {
    await workflow.get(id);
    return { ok: true };
  }
  const params = call?.params as Partial<GroupTurnParams> | undefined;
  if (call?.op !== "create" || typeof params?.inbox !== "string" || typeof params?.turn !== "string") throw new TypeError("a group turn starts with its chat's id and turn");
  await workflow.create({ id, params: { inbox: params.inbox, turn: params.turn } });
  return { ok: true };
}

/** A job's id, as a chat names it (`jobs.ts`). */
const JOB = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Start, or find, one background job's Workflow (`jobWorkflow.ts`) for a job the gateway's `TexJob` holds: the pass
 * loop's waiting stays here, and each pass reaches the job where it was born (`jobPlace.ts`). `create` takes exactly
 * what `startJobFlow` passes; nothing else of the job crosses.
 */
export async function jobRun(
  workflow: Pick<Workflow<JobRunParams>, "create" | "get"> | undefined,
  call: { op?: unknown; id?: unknown; params?: unknown } | null,
): Promise<{ ok: true }> {
  if (workflow === undefined) throw new Error("no job workflow here");
  const id = call?.id;
  if (typeof id !== "string" || id === "" || id.length > 100) throw new TypeError("a job's workflow is named by its id");
  if (call?.op === "get") {
    await workflow.get(id);
    return { ok: true };
  }
  const params = call?.params as Partial<JobRunParams> | undefined;
  if (call?.op !== "create" || typeof params?.job !== "string" || !JOB.test(params.job)) throw new TypeError("a job's workflow starts with the job's id");
  await workflow.create({ id, params: { job: params.job } });
  return { ok: true };
}
