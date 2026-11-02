/**
 * `POST /gateway/browser-profile`: the saved Browserbase profile Tex's
 * browser opens (`functions/browserProfiles.ts`).
 *
 *   `{ accessToken, expectedWorkspaceId, owner, chat?, forget? }`
 *     → `{ profileId, created }`, `{ profileId: null }`, or `{ forgotten }`
 *
 * The token resolves to a live grant on its own, and `expectedWorkspaceId`
 * only selects within that grant's set, as on every gateway route. A person's
 * browser (no `chat`) is filed under their personal workspace and a group
 * chat's under its shared one, the same places their sealed jars are kept.
 * `owner` is the gateway's own HMAC tag for the browser, which only the
 * gateway can make. `forget` is "sign Tex out": the profile is released.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { createBrowserbaseProfile } from "../../browserProfiles";
import { hashToken } from "../crypto";
import { json, stringField } from "../gatewayAuth";

const OWNER_TAG = /^[a-f0-9]{64}$/;

export async function gatewayBrowserProfileHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const accessToken = stringField(body, "accessToken");
  const expected = stringField(body, "expectedWorkspaceId");
  const owner = stringField(body, "owner");
  const chat = stringField(body, "chat");
  if (accessToken === null || expected === null || owner === null || !OWNER_TAG.test(owner)) return json({ profileId: null });
  if (chat !== null && !OWNER_TAG.test(chat)) return json({ profileId: null });

  const session = await ctx.runQuery(internal.functions.controlPlane.resolveGrantByAccessToken, {
    hashedAccessToken: await hashToken(accessToken),
  });
  const covered = session?.workspaces.find((entry) => entry.workspaceId === expected) ?? null;
  if (covered === null || covered.setupOnly === true) return json({ profileId: null });
  // Where the browser's jar is kept is where its profile is filed.
  if (covered.kind !== (chat === null ? "personal" : "shared")) return json({ profileId: null });
  const workspaceId = covered.workspaceId;

  if (body.forget === true) {
    const forgotten = await ctx.runMutation(internal.functions.browserProfiles.forgetProfile, { workspaceId, owner });
    return json({ forgotten });
  }
  const live = await ctx.runQuery(internal.functions.browserProfiles.liveProfile, { workspaceId, owner });
  if (live !== null) return json({ profileId: live, created: false });
  const made = await createBrowserbaseProfile();
  if (made === null) return json({ profileId: null });
  const kept = await ctx.runMutation(internal.functions.browserProfiles.keepProfile, {
    workspaceId,
    owner,
    ...(chat !== null ? { chat } : {}),
    profileId: made,
  });
  return json(kept === null ? { profileId: null } : { profileId: kept, created: kept === made });
}
