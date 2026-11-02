/**
 * `POST /gateway/access/profiles` — `{ people: [{ userId, personalWorkspaceId? }] }`
 * → `{ profiles: [{ userId, name?, email?, handle? }] }`, behind the gateway's
 * secret only (`gatewayRoute`). The caller is a workspace object that has
 * already proved, through its own member rows, that the reader may see these
 * people; this route never decides that (`functions/accessProfiles.ts`).
 * Always 200; a body that is not a list answers no profiles.
 */

import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import { MAX_PROFILES } from "../../accessProfiles";
import { json } from "../gatewayAuth";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function gatewayAccessProfilesHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  if (!Array.isArray(body.people)) return json({ profiles: [] });
  const people = (body.people as unknown[])
    .slice(0, MAX_PROFILES)
    .map((given) => (given !== null && typeof given === "object" ? (given as Record<string, unknown>) : {}))
    .filter((given) => typeof given.userId === "string" && ID.test(given.userId))
    .map((given) => ({
      userId: given.userId as string,
      ...(typeof given.personalWorkspaceId === "string" && ID.test(given.personalWorkspaceId) ? { personalWorkspaceId: given.personalWorkspaceId } : {}),
    }));
  if (people.length === 0) return json({ profiles: [] });
  return json({ profiles: await ctx.runQuery(internal.functions.accessProfiles.profilesFor, { people }) });
}
