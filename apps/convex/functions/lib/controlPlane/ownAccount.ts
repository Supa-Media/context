/**
 * Whose own Google account a gateway call may act on: send one email, change
 * one calendar event (`functions/personEmail.ts`, `functions/calendarWrite.ts`).
 *
 * Always the grant's own person, from their personal workspace. Two kinds of
 * grant reach it:
 *
 * - An editor grant on that personal workspace itself, as before: an editor
 *   grant on a shared one never reaches its holder's mail or calendar.
 * - A Tex group chat's grant (`functions/textGroups.ts`), for its tagger (the
 *   owner, 2026-10-21: "calendar is necessary", "email too, write only not
 *   read"). Its workspace is the chat's one shared workspace and must be the
 *   one the call names; it resolves only while everyone in the chat still
 *   shares it (`liveGrants.ts`). Its role there doesn't matter: the change is
 *   to the tagger's own account, and the gateway holds each for the tagger's
 *   yes to the exact copy. Reading their mail never goes through here.
 */

import type { QueryCtx } from "../../../_generated/server";
import type { Doc, Id } from "../../../_generated/dataModel";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { ownedPersonalWorkspace } from "../accountSetup";
import { TEXTS_GROUP_CLIENT_ID } from "../../textGroups";
import { resolveLiveGrant } from "./liveGrants";
import { editorClearanceForGatewayHandler } from "./session";

export type OwnAccount = { personal: Doc<"workspaces">; actorUserId: Id<"users">; clientId: string };

export async function ownAccountClearance(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<OwnAccount | null> {
  if (!TOKEN_HASH_PATTERN.test(args.hashedAccessToken)) return null;
  const live = await resolveLiveGrant(ctx, args.hashedAccessToken);
  if (live === null) return null;
  if (live.grant.clientId === TEXTS_GROUP_CLIENT_ID) {
    if (String(live.grant.workspaceId) !== args.expectedWorkspaceId) return null;
    const personal = await ownedPersonalWorkspace(ctx, live.grant.userId);
    if (personal === null || personal.createdBy !== live.grant.userId) return null;
    return { personal, actorUserId: live.grant.userId, clientId: live.grant.clientId };
  }
  const cleared = await editorClearanceForGatewayHandler(ctx, args);
  if (cleared === null) return null;
  const personal = await ownedPersonalWorkspace(ctx, cleared.actorUserId);
  if (personal === null || personal.createdBy !== cleared.actorUserId || cleared.workspaceId !== personal._id) return null;
  return { personal, actorUserId: cleared.actorUserId, clientId: cleared.clientId };
}
