import { createTransport, ControlPlaneError, sha256Hex, isLoopbackHost } from "./client.js";
import { createSessionMethods } from "./session.js";
import { createGrantMethods } from "./grants.js";
import { createReportingMethods } from "./reporting.js";
import { createJobMethods } from "./jobs.js";
import { createLinkMethods } from "./links.js";
import { createFeedbackMethods } from "./feedback.js";
import { createSiteMethods } from "./site.js";
import { createVaultMethods } from "./vault.js";
import { createTreeMethods } from "./tree.js";
import { createNoteIdMethods } from "./noteIds.js";
import { createPrivacyMethods } from "./privacy.js";
import { createMailMethods } from "./mail.js";
import { createEmailMethods } from "./email.js";
import { createWorkspaceMethods } from "./workspaces.js";
import { createDreamMethods } from "./dreams.js";

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
    ...createFeedbackMethods({ post }),
    ...createSiteMethods({ post, required }),
    ...createVaultMethods({ post, required }),
    ...createTreeMethods({ post }),
    ...createNoteIdMethods({ post, required }),
    ...createPrivacyMethods({ post }),
    ...createMailMethods({ post }),
    ...createEmailMethods({ post }),
    ...createWorkspaceMethods({ post, required }),
    ...createDreamMethods({ post }),
  };
}
