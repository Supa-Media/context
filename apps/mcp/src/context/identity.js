/**
 * Who is acting and which contexts a session reaches: the audit actor, a
 * personal context's display name, the reachable-context list, and a
 * context's addressable name. One copy, shared with Tex, in
 * `packages/shared/src/texContract/identity.cjs`.
 */

export { actorFor, personalNameFor, editsPinnedContext, contextsFor, contextNameFor } from "../../../../packages/shared/src/texContract/identity.cjs";
