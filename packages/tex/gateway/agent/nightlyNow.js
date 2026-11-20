/**
 * THE NIGHTLY, RUN NOW (Dev2, 2026-11-20: "I know it's running nightly, but I want to be able to be like, okay, let's
 * run it now ... if we want to do some type of migration or we want to update things").
 *
 * The same graph run the nightly route makes (`nightlyRoute.js`): `nightly` starts the night's `dream` or
 * `housekeeping` and whatever the config wires after them (About me's upkeep, the day summaries), on a config the
 * caller names (main, or a Lab draft through `withDraft`), with `force` so a weekly step runs today. The Lab's Nightly
 * page and `tex_dev nightly` call it (`packages/lab/gateway/labSandbox/nightly.js`), on a test copy of the person's
 * own workspace or, when they ask, on the workspace itself. Answers what each step gave and what About me became.
 */

import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { aboutMeChanges } from "./dream.js";
import { readAboutMe } from "./aboutMe.js";
import { actorFor, contextsFor } from "../../../../apps/mcp/src/context/identity.js";
import { callToolForSession } from "../../../../apps/mcp/src/tools/session.js";
import { newLedger } from "../../../../apps/mcp/src/privacy/egress.js";

export const NIGHTLY_RUNS = Object.freeze(["dream", "housekeeping"]);
const OUT_CHARS = 2_000;

/** A step's output as the answer carries it: its JSON, cut. */
function shown(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > OUT_CHARS ? `${text.slice(0, OUT_CHARS)}…` : value;
}

/**
 * Run the nightly graph for one person now. `config` the config to run (main's by default), `writer` the ledger the
 * steps are kept in (null keeps none; a Lab test copy's gate sees them through `env`), `since` where the dream's chat
 * starts (null: the last few days); `dispatch` and `nodes` only for tests. Answers `{ ran, outputs, about: { before, after, added, removed } }`.
 */
export async function runNightlyNow({ env, store, session, controlPlane, config, run = "dream", timeZone, since = null, force = true, writer = null, dispatch: given = null, nodes = undefined }) {
  if (!NIGHTLY_RUNS.includes(run)) throw new TypeError(`run is ${NIGHTLY_RUNS.join(" or ")}`);
  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  // As the nightly route: nothing it reads is sent anywhere, and what it writes is in their own workspace.
  session.egress = { complete: true, ledger: newLedger(), texting: false };
  const dispatch = given ?? ((name, args) => callToolForSession({ name, arguments: args }, store, session));
  const zone = readTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
  const before = await readAboutMe(dispatch);
  const graph = gatewayGraph({ env, writer, ...(config ? { config } : {}), ...(nodes ? { nodes } : {}) });
  let result;
  try {
    result = await graph.run("nightly", { run, timeZone: zone, ...(Number.isFinite(since) ? { since } : {}) }, { env, store, session, controlPlane, dispatch, force });
  } finally {
    await writer?.flush?.();
  }
  const after = await readAboutMe(dispatch);
  const changes = aboutMeChanges(before, after);
  return {
    ran: result.ran,
    outputs: Object.fromEntries(Object.entries(result.outputs).map(([id, out]) => [id, shown(out)])),
    about: { before: before.length, after: after.length, added: changes.added, removed: changes.removed },
  };
}
