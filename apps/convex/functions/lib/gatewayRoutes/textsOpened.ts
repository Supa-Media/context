/**
 * `POST /gateway/texts/opened` — `{ personalWorkspaceId, phone, hashedAccessToken, expiresAt }` →
 * `{ status: "linked" | "unlinked" }`.
 *
 * A text's session the person object opened (`apps/mcp/src/agent/textsSession.js`). Behind the gateway's secret. Convex
 * re-checks the phone, keeps its copy of the grant under this hash, re-arms and audits (`functions/textingObjects.ts`
 * `keepOpened`). The token itself never reaches here; anything malformed is "unlinked", one answer for every reason.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { hashToken } from "../crypto";
import { json, randomOpaqueToken, stringField } from "../gatewayAuth";
import { TEXTS_GRANT_TTL_MS } from "../../textLinks";

const HASH = /^[0-9a-f]{64}$/;
const UNLINKED = () => json({ status: "unlinked" });

export async function gatewayTextsOpenedHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const personalWorkspaceId = stringField(body, "personalWorkspaceId");
  const phone = stringField(body, "phone");
  const hashedAccessToken = stringField(body, "hashedAccessToken");
  const expiresAt = body.expiresAt;
  if (personalWorkspaceId === null || phone === null || hashedAccessToken === null || !HASH.test(hashedAccessToken)) return UNLINKED();
  const now = Date.now();
  // A texting token lives fifteen minutes, as the object keeps it; a longer one is refused rather than trusted.
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + TEXTS_GRANT_TTL_MS + 60_000) return UNLINKED();
  const workspaceId = await ctx.runQuery(internal.functions.textingObjects.workspaceIdOf, { id: personalWorkspaceId });
  if (workspaceId === null) return UNLINKED();
  const status: "linked" | "unlinked" = await ctx.runMutation(internal.functions.textingObjects.keepOpened, {
    personalWorkspaceId: workspaceId as Id<"workspaces">,
    phone,
    hashedAccessToken,
    // The hash of a value nobody was given: a texting grant is never refreshed (as `agentTextsSessionHandler`).
    hashedRefreshToken: await hashToken(`unissued_${randomOpaqueToken(32)}`),
    expiresAt,
  });
  return json({ status });
}
