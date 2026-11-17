/**
 * `POST /agent/job/part-end` `{ jobId, input }` → the Part end node's choice for a job's part (Dev2, 2026-11-17, "jobs
 * as config", step 6; the node is `graph/nodes/partEnd.js`, its rule `packages/shared/src/jobPartEnd.cjs`).
 *
 * The texting Worker's `runJob` asks this after each part, so what follows it (the next part, the last draft, or the
 * end) is the config's node, run on the runner and logged like every step, under the limits on that node's config.
 * While the job's pass runs here, the job node's own wire is used (`graph/jobHandles.js`); otherwise the config's
 * `job -> partEnd` wire; and while the node is still on the shelf (no wire), the same rule on its default limits.
 */
import { json } from "../http/responses.js";
import { hasScope, SCOPE_WRITE } from "../session.js";
import { borrowJob } from "./graph/jobHandles.js";
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { TEX_CONFIG, texConfigOf } from "./texConfig.js";
import { jobTagged, storeLedger } from "./ledger.js";
import { decidePartEnd } from "../../../../packages/shared/src/jobPartEnd.cjs";

export const JOB_PART_END_PATH = "/agent/job/part-end";

const TEXTING_CLIENTS = new Set(["context_texts", "context_texts_group"]);

/**
 * The choice, by the job's own wire, the config's wire, or the rule itself while the node is unwired. `writer` is the
 * job's chat log, where the runner logs the node's run under the job, as every step is.
 */
export async function partEndFor(jobId, input, { config = TEX_CONFIG, graph = null, writer = null, env = null } = {}) {
  const lent = borrowJob(jobId);
  if (lent !== null && "partEnd" in lent.use) return await lent.use.partEnd(input);
  const wired = config.edges.some((e) => e.from === "job" && e.to === "partEnd");
  if (wired) return await (graph ?? gatewayGraph({ env, writer, config })).fire("job", "partEnd", input);
  return decidePartEnd(input, config.nodes?.find((node) => node.id === "partEnd")?.limits ?? null);
}

/** The route, for a session resolved from the job's texting token. */
export async function handleJobPartEnd(request, env, store, session, deps = {}) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!TEXTING_CLIENTS.has(session.actorClientId) || !hasScope(session, SCOPE_WRITE)) return json({ error: "forbidden" }, 403);
  const body = await request.json().catch(() => null);
  if (body === null || typeof body.jobId !== "string" || body.input === null || typeof body.input !== "object") return json({ error: "bad_request" }, 400);
  // Only the facts the rule reads, so nothing else a caller sends reaches the node or its log.
  const i = body.input;
  const input = { cause: String(i.cause ?? "").slice(0, 40), part: Number(i.part) || 1, startedAt: Number(i.startedAt) || 0, now: Number(i.now) || 0, machine: i.machine === true, hasDraft: i.hasDraft === true, idle: i.idle === true, wasIdle: i.wasIdle === true, rejected: i.rejected === true, ...(i.refusal === "daily_limit" || i.refusal === "no_model" ? { refusal: i.refusal } : {}), ...(i.checked === "done" || i.checked === "waiting" || i.checked === "stuck" ? { checked: i.checked } : {}) };
  const writer = store ? jobTagged(storeLedger(store, session), { id: body.jobId }) : null;
  const choice = await partEndFor(body.jobId, input, { config: env ? texConfigOf(env) : TEX_CONFIG, writer, env, ...deps });
  await writer?.flush?.();
  return json(choice);
}
