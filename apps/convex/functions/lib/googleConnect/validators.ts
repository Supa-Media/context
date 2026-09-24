/**
 * The larger argument and return validators of the Google connect functions
 * whose bodies stay in `functions/googleConnect.ts` — the ones that call,
 * schedule or decrypt, and so must stay beside their registration for
 * `__tests__/structure.test.ts` to see it.
 *
 * Moved verbatim; the registrations pass them to Convex unchanged. This
 * module registers nothing.
 */

import { v } from "convex/values";

export const startGmailConnectArgs = {
  workspaceId: v.id("workspaces"),
  redirectUri: v.string(),
  backfillDays: v.optional(v.number()),
  folders: v.optional(v.array(v.union(v.literal("inbox"), v.literal("sent")))),
  attachmentMode: v.optional(v.union(v.literal("metadata-only"), v.literal("store"))),
  attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
};

export const startGmailConnectReturns = v.object({ authorizeUrl: v.string(), completionSecret: v.string() });

export const startGoogleConnectArgs = {
  workspaceId: v.id("workspaces"),
  redirectUri: v.string(),
  syncServices: v.object({ gmail: v.boolean(), calendar: v.boolean(), chat: v.boolean() }),
  backfillDays: v.optional(v.number()),
  folders: v.optional(v.array(v.union(v.literal("inbox"), v.literal("sent")))),
  attachmentMode: v.optional(v.union(v.literal("metadata-only"), v.literal("store"))),
  attachmentRetentionDays: v.optional(v.union(v.number(), v.literal("forever"))),
};

export const startGoogleConnectReturns = v.object({ authorizeUrl: v.string(), completionSecret: v.string() });

export const completeGmailConnectArgs = {
  state: v.string(),
  code: v.string(),
  /*
    Optional, and defaulted to the empty string rather than required.

    A required arg makes a browser still running yesterday's bundle fail with
    a Convex validator error instead of this flow's one refusal — a
    distinguishable answer, for the length of a deploy, on the one path whose
    whole point is that its four failures look identical. The empty string
    fails the comparison exactly as a wrong secret does, so nothing is
    loosened by accepting it.
  */
  completionSecret: v.optional(v.string()),
};

export const completeGmailConnectReturns = v.object({ workspaceId: v.id("workspaces") });

export const exchangeAndBindArgs = {
  workspaceId: v.id("workspaces"),
  boundBy: v.id("users"),
  encryptedVerifier: v.string(),
  code: v.string(),
  redirectUri: v.string(),
  backfillDays: v.number(),
  folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
  attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
  attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
};

export const exchangeAndBindReturns = v.null();

export const exchangeAndBindGoogleArgs = {
  workspaceId: v.id("workspaces"),
  boundBy: v.id("users"),
  encryptedVerifier: v.string(),
  code: v.string(),
  redirectUri: v.string(),
  products: v.array(v.union(v.literal("gmail"), v.literal("calendar"), v.literal("chat"))),
  backfillDays: v.number(),
  folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
  attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
  attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
};

export const exchangeAndBindGoogleReturns = v.null();
