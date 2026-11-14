/**
 * `/agent` for Tex's two nightly clients (`http/route.js` sends them here by the grant's client, never by the body).
 * The work is the graph's: `texConfig.json` runs `nightly` (`graph/nodes/nightly.js`), which starts the night's
 * `dream` (`dream.js`, `graph/nodes/dream.js`) or `housekeeping` (`housekeeping.js`, `graph/nodes/housekeep.js`), and
 * the day summaries after a dream (`graph/nodes/daysum.js`). This file keeps only the plumbing a request needs: the
 * client, the body, the store and session, and the dispatcher. It answers with what the run answered.
 */
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { DREAMS_CLIENT_ID } from "./dream.js";
import { HOUSEKEEPING_CLIENT_ID } from "./housekeeping.js";
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { sessionLedger } from "./ledger.js";
import { actorFor, contextsFor } from "../context/identity.js";
import { callToolForSession } from "../tools/session.js";
import { newLedger } from "../privacy/egress.js";
import { json } from "../http/responses.js";

/**
 * `/agent` for the dreams client: it dreams, and does nothing else. A `dream` body from any other client goes to the
 * ordinary turn, which has no use for it.
 */
export async function handleDream(request, env, store, session, controlPlane) {
  if (session.actorClientId !== DREAMS_CLIENT_ID) return json({ error: "invalid_request", error_description: "Only Tex's dreams dream." }, 403);
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const asked = body?.dream !== undefined && body.dream !== null && typeof body.dream === "object" && !Array.isArray(body.dream);
  if (!asked) return json({ error: "invalid_request", error_description: "This connection only dreams." }, 400);

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  // Nothing a dream reads is sent anywhere, and the one thing it writes is in their own workspace.
  session.egress = { complete: true, ledger: newLedger(), texting: false };
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);

  const timeZone = readTimeZone(body.dream.timeZone) ?? DEFAULT_TIME_ZONE;
  const since = typeof body.dream.since === "number" && Number.isFinite(body.dream.since) ? body.dream.since : null;
  const { outputs } = await night(env, session, { run: "dream", timeZone, ...(since !== null ? { since } : {}) }, { env, store, session, controlPlane, dispatch });
  return json(outputs.dream.body, outputs.dream.status);
}

/**
 * One housekeeping run, for whichever turn handler the caller's client is routed to (`http/route.js`). The caller
 * decides when; the graph decides what (`nightly` runs `housekeep`).
 */
export async function handleHousekeeping(request, env, store, session, controlPlane) {
  if (session.actorClientId !== HOUSEKEEPING_CLIENT_ID) return json({ error: "invalid_request", error_description: "Only Tex's housekeeping keeps house." }, 403);
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const asked = body?.housekeeping !== undefined && body.housekeeping !== null && typeof body.housekeeping === "object" && !Array.isArray(body.housekeeping);
  if (!asked) return json({ error: "invalid_request", error_description: "This connection only keeps house." }, 400);

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  // Nothing housekeeping reads is sent anywhere, and nothing it changes widens who sees it.
  session.egress = { complete: true, ledger: newLedger(), texting: false };
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);

  const timeZone = readTimeZone(body.housekeeping.timeZone) ?? DEFAULT_TIME_ZONE;
  const { outputs } = await night(env, session, { run: "housekeeping", timeZone }, { env, store, session, controlPlane, dispatch });
  return json(outputs.housekeep.body, outputs.housekeep.status);
}

/** The night's run on the graph, every node of it kept as a node step in the person's own chat ledger, flushed before the answer. */
async function night(env, session, input, ctx) {
  const writer = sessionLedger(env, session);
  try {
    return await gatewayGraph({ writer }).run("nightly", input, ctx);
  } finally {
    await writer?.flush();
  }
}
