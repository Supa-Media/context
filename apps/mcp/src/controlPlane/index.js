import { createTransport, ControlPlaneError, sha256Hex, isLoopbackHost } from "./client.js";
import { createSessionMethods } from "./session.js";
import { createGrantMethods } from "./grants.js";
import { createReportingMethods } from "./reporting.js";
import { createJobMethods } from "./jobs.js";
import { createLinkMethods } from "./links.js";

export { ControlPlaneError, sha256Hex, isLoopbackHost };

/**
 * A typed client for the contract documented at the top of `../controlPlane.js`.
 *
 * Constructed per request. It holds the gateway secret in memory for the life
 * of one call and nothing else — no connection pool, no memo, no module-level
 * state that a reused isolate could carry into the next tenant's request.
 */
export function createControlPlane(env, options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const { post, required } = createTransport(env, fetchImpl);

  return {
    ...createSessionMethods({ post, required }),
    ...createGrantMethods({ post, required }),
    ...createReportingMethods({ post, required }),
    ...createJobMethods({ post, required }),
    ...createLinkMethods({ post, required }),
  };
}
