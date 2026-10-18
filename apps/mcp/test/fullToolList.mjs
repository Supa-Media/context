/**
 * The FULL tool list a connection is entitled to: `toolsForSession` with the
 * older shape (`shape: "v1"`), for the session `tools/list` serves that
 * connection.
 *
 * `tools/list` over HTTP answers the six v2 tools
 * (docs/decisions/gateway-protocol/six-tools.md) and nothing else. The filters
 * the older checks are about — read-only, tier, masking, plugins — are applied
 * in `toolsForSession` for both shapes, so a check of those filters reads them
 * here, and a check of what a client is offered reads the HTTP list.
 *
 * `store` is what `disabledToolNames` reads the plugin switches from; the
 * default is a store with none written, so every plugin is on.
 */

import { resolveSession } from "../src/session.js";
import { createControlPlane } from "../src/controlPlane/index.js";
import { toolsForSession } from "../src/tools/advertised.js";

const NO_SETTINGS = { async get() { return null; } };

export async function fullToolList(env, token, store = NO_SETTINGS) {
  const session = await resolveSession(token, null, createControlPlane(env));
  return toolsForSession(session, store, { shape: "v1" });
}

/** The six v2 names, sorted, as `tools/list` is expected to answer them. */
export const V2_LIST_NAMES = ["fetch", "manage", "orient", "search", "send", "write"];
