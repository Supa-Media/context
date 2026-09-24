/**
 * Whether a live relay (a presence or collaboration socket) may join: the
 * room's own authorization callback, re-derived from the grant and the live
 * privacy manifest on every join.
 */

import {
  accessForLiveGrant,
  hasScope,
  resolveSession,
  SCOPE_READ,
  SCOPE_WRITE,
  storeForSession,
} from "../session.js";
import { canSee } from "../privacy/engine.js";
import { collaborationHead } from "./collaborationHttp.js";
import { createControlPlane } from "../controlPlane.js";
import { presenceClientKey as livePresenceClientKey } from "./presence.js";
import { loadPrivacyState } from "../privacy/state.js";
import { objectExists } from "../storageLayout.js";

export const presenceClientKey = livePresenceClientKey;

/**
 * Re-authorize one speculative collaboration update without persisting it.
 *
 * The sender proves itself with the bearer carried by this frame. Recipients
 * are the bounded live roster and are re-checked by opaque grant id in one
 * control-plane request. The only bucket reads are the current privacy state,
 * logical existence, and collaboration head; update bytes never leave the
 * room and this path never writes the bucket.
 */
export async function authorizeLiveRelay(env, { sender, accessToken, documentId, recipients }) {
  const refused = { sender: false, recipients: new Set() };
  if (
    !sender || typeof sender !== "object" ||
    typeof sender.grantId !== "string" || !sender.grantId ||
    typeof sender.workspaceId !== "string" || !sender.workspaceId ||
    typeof sender.path !== "string" || !sender.path ||
    typeof sender.clientKey !== "string" || !sender.clientKey ||
    typeof documentId !== "string" || !documentId || documentId !== sender.documentId ||
    typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 4096 ||
    !Array.isArray(recipients) || recipients.length > 23
  ) {
    return refused;
  }

  const controlPlane = createControlPlane(env);
  let session;
  let store;
  try {
    session = await resolveSession(accessToken, sender.workspaceSlug || null, controlPlane);
    if (
      session.grantId !== sender.grantId || session.workspaceId !== sender.workspaceId ||
      !hasScope(session, SCOPE_READ) || !hasScope(session, SCOPE_WRITE) ||
      await presenceClientKey(session.actorClientId) !== sender.clientKey
    ) {
      return refused;
    }
    store = await storeForSession(session, env, controlPlane);
  } catch {
    return refused;
  }

  const uniqueGrantIds = [...new Set(recipients.map((recipient) => recipient?.grantId))];
  if (uniqueGrantIds.some((grantId) => typeof grantId !== "string" || !grantId)) return refused;

  let privacy;
  let head;
  let physicallyPresent;
  let rows;
  try {
    [privacy, head, physicallyPresent, rows] = await Promise.all([
      loadPrivacyState(store),
      collaborationHead(store, sender.path),
      objectExists(store, sender.path, { metadataOnly: true }),
      uniqueGrantIds.length > 0
        ? controlPlane.resolveGrantSessions(sender.workspaceId, uniqueGrantIds)
        : Promise.resolve([]),
    ]);
  } catch {
    return refused;
  }
  if (
    privacy.error || !physicallyPresent || head?.status !== "active" || head.documentId !== documentId ||
    !canSee(sender.path, session.scope, privacy.rules, privacy.overrides, session.grantedGroups)
  ) {
    return refused;
  }
  // Resolve a possible logical-delete marker only after the freshly resolved
  // sender may see the note. Metadata-only probing above must never download a
  // hidden note body on behalf of a revoked or narrowed grant.
  try {
    if (!await objectExists(store, sender.path)) return refused;
  } catch {
    return refused;
  }

  const accessByGrant = new Map();
  for (let index = 0; index < uniqueGrantIds.length; index += 1) {
    const access = accessForLiveGrant(rows[index], sender.workspaceId);
    if (access?.grantId === uniqueGrantIds[index]) accessByGrant.set(access.grantId, access);
  }
  const allowed = new Set();
  for (const recipient of recipients) {
    const access = accessByGrant.get(recipient.grantId);
    if (
      access && hasScope(access, SCOPE_READ) &&
      canSee(sender.path, access.scope, privacy.rules, privacy.overrides, access.grantedGroups)
    ) {
      allowed.add(recipient.id);
    }
  }
  return { sender: true, recipients: allowed };
}
