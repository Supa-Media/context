/**
 * Whether the person a session acts for has a feature flag on (`docs/decisions/app-and-console/feature-flags.md`).
 * The session already carries their set (`session.flags`, from their person object or the control plane), so this
 * is a lookup with no call. Off for an id not in `packages/shared/src/flags.cjs`, a session with no set, or no session.
 *
 *   if (flagOn(session, "tex.conversation-threads")) { ... }
 */

import { isFlagId } from "../../../packages/shared/src/flags.cjs";

export function flagOn(session, flagId, known = isFlagId) {
  if (!known(flagId)) return false;
  return Array.isArray(session?.flags) && session.flags.includes(flagId);
}
