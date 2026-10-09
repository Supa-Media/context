/**
 * Who sign-in codes come from, set in the admin console's Credentials tab
 * (Dev2, 2026-10-09: "why can't I keep it in the /admin page").
 *
 * Only the Messaging Service ID lives here. It names the sender and opens
 * nothing, so it is stored plain and shown back; the account SID and auth
 * token that send through it stay in the deployment's environment. A value in
 * the environment wins, so a deployment that names its sender is never
 * overridden by a paste.
 */

import { ConvexError, v } from "convex/values";
import { twilioSmsKeys } from "@supa-media/convex/auth";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { AdminActor } from "../admin";
import { recordAdminAudit } from "./audit";

/** `MG` and 32 hex digits, as Twilio prints a Messaging Service SID. */
const MESSAGING_SERVICE_SID = /^MG[0-9a-f]{32}$/i;

export const signInTextsValidator = v.object({
  messagingServiceSid: v.union(v.string(), v.null()),
  /** The deployment names a sender itself, and that one is used. */
  fromDeployment: v.boolean(),
  /** Codes go out in Context's own words, rather than through Verify. */
  saysContext: v.boolean(),
});

export async function storedMessagingServiceSid(ctx: QueryCtx): Promise<string | null> {
  return (await ctx.db.query("smsSettings").first())?.messagingServiceSid ?? null;
}

export async function signInTextsHandler(ctx: QueryCtx) {
  const messagingServiceSid = await storedMessagingServiceSid(ctx);
  const fromDeployment = twilioSmsKeys() !== null;
  const saysContext =
    fromDeployment ||
    (messagingServiceSid !== null &&
      twilioSmsKeys({ ...process.env, TWILIO_MESSAGING_SERVICE_SID: messagingServiceSid }) !== null);
  return { messagingServiceSid, fromDeployment, saysContext };
}

/** Keep `raw` as the sender; an empty value clears it. */
export async function setSignInTextsSenderHandler(ctx: MutationCtx, raw: string, actor: AdminActor) {
  const value = raw.trim();
  if (value !== "" && !MESSAGING_SERVICE_SID.test(value)) {
    throw new ConvexError({
      code: "INVALID_ARGUMENT",
      message: "That isn't a Messaging Service ID. It starts with MG and is 34 characters long.",
    });
  }
  const fields = { messagingServiceSid: value === "" ? undefined : value, updatedAt: Date.now(), updatedBy: actor.userId };
  const row = await ctx.db.query("smsSettings").first();
  if (row === null) await ctx.db.insert("smsSettings", fields);
  else await ctx.db.replace(row._id, fields);
  await recordAdminAudit(ctx, actor, "texts.sender_set", "sign-in", { cleared: value === "" });
  return null;
}
