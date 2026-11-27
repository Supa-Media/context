/**
 * `POST /files/area-routines`: the app's area panel asking how each of the workspace's area routines last ran, when it
 * runs next, and what each bot has spent of its week per area (`docs/decisions/app-and-console/area-routines.md`).
 * Under `/files/`, a first segment no workspace can be called; the app addresses it as `/@<slug>/files/area-routines`.
 *
 * Body: `{workspaceId}`. The answer is the workspace object's `state` (`workspaceStore/areaRoutines.js`) read at this
 * session's own clearance (`store/objectBots.js`): a routine whose path it cannot read is left out, and so is a bot's
 * week in an area whose about.md it cannot read. Paths, times, outcomes and percentages only: never a routine's words.
 *
 * - **The Context app only** (`context_console`): an agent reads the same through `orient { area }`.
 * - **The session's own workspace only**, checked before anything is asked of an object.
 * - `{served: false}` where the workspace's notes are not yet in their object, or the object can't answer.
 * - `run: <routine path>` sends that routine to its bot now, as its clock would (its bot, list and share: Run now never
 *   sends past a cap), for a session that may write here; the answer adds `ran`, the outcome, or null for no routine
 *   this session can read.
 */

import { json } from "./responses.js";
import { SCOPE_WRITE } from "../session.js";

export const AREA_ROUTINES_PATH = "/files/area-routines";

/** The console's client (`CONSOLE_CLIENT_ID` in `apps/convex/functions/agentGrant.ts`). */
const CONSOLE_CLIENT_ID = "context_console";
const MAX_BODY_BYTES = 1024;

async function readBody(request) {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    if (Object.keys(body).some((key) => key !== "workspaceId" && key !== "run")) return null;
    if (body.run !== undefined && !(typeof body.run === "string" && body.run !== "" && body.run.length <= 512)) return null;
    return typeof body.workspaceId === "string" && body.workspaceId !== "" && body.workspaceId.length <= 128 ? body : null;
  } catch {
    return null;
  }
}

/** `(request, store, session, path, env)`, an app route (`appRoutes.js`). */
export async function handleAreaRoutines(request, store, session) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (session?.actorClientId !== CONSOLE_CLIENT_ID) return json({ error: "forbidden", error_description: "Only the Context app asks this; an agent reads it with orient { area }." }, 403);
  const body = await readBody(request);
  if (body === null) return json({ error: "invalid_request" }, 400);
  // Checked before anything is read: a call filed under one workspace never reaches another's object.
  if (body.workspaceId !== session.workspaceId) return json({ error: "wrong_workspace" }, 409);
  // Run now: one routine sent to its bot out of turn, by someone who may change this workspace, then the state as after.
  let ran;
  if (body.run !== undefined) {
    if (!(session.scopes ?? []).includes(SCOPE_WRITE)) return json({ error: "forbidden", error_description: "Only an editor or owner can run a routine now." }, 403);
    ran = typeof store?.objectBots?.runNow === "function" ? await store.objectBots.runNow(body.run) : undefined;
    if (ran === undefined) return json({ served: false });
  }
  const state = typeof store?.objectBots?.state === "function" ? await store.objectBots.state() : null;
  if (state === null) return json({ served: false });
  return json({ served: true, week: state.week, routines: state.routines, usage: state.usage, ...(body.run === undefined ? {} : { ran: ran ?? null }) });
}
