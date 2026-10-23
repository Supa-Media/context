/**
 * Whether a person's mailboxes are working, for their own agents
 * (`docs/decisions/communications/mail-health.md`).
 *
 * Registrations only; the logic is in `lib/mailHealth/`. Read off the
 * connection rows, never mail.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mailHealthHandler, raiseMailNoticesHandler } from "./lib/mailHealth/read";

const mailboxState = v.union(
  v.literal("ok"),
  v.literal("needs_reconnect"),
  v.literal("store_full"),
  v.literal("stale"),
  v.literal("recovering"),
);

export const mailHealth = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.union(
    v.null(),
    v.array(
      v.object({
        address: v.string(),
        state: mailboxState,
        lastSyncedAt: v.union(v.number(), v.null()),
        tell: v.boolean(),
        readOnly: v.boolean(),
      }),
    ),
  ),
  handler: mailHealthHandler,
});

export const raiseMailNotices = internalMutation({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    mailboxes: v.array(v.object({ address: v.string(), state: v.string() })),
  },
  returns: v.number(),
  handler: raiseMailNoticesHandler,
});
