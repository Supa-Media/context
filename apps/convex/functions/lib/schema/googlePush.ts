import { v } from "convex/values";

/** When a watch last failed to register, and why, in our own words. */
const failure = {
  failedAt: v.optional(v.number()),
  failure: v.optional(v.string()),
};

/** The shape of `googleConnections.push`. See `lib/googlePush/`. */
export const googlePushValidator = v.object({
  gmail: v.optional(
    v.object({
      /** Lowercased: the `emailAddress` a Gmail notification carries. */
      address: v.optional(v.string()),
      topic: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      ...failure,
    }),
  ),
  calendar: v.optional(
    v.object({
      channelId: v.optional(v.string()),
      resourceId: v.optional(v.string()),
      /** SHA-256 (hex) of the channel token Google echoes on every notification. */
      tokenHash: v.optional(v.string()),
      address: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      ...failure,
    }),
  ),
  chat: v.optional(
    v.object({
      /** `subscriptions/…`, as a Workspace Events notification's `ce-source` names it. */
      subscriptionName: v.optional(v.string()),
      topic: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      ...failure,
    }),
  ),
  /**
   * Products a notification has asked to be synced, each with when the latest
   * notification arrived. A pass clears a product only if nothing arrived
   * after it was claimed, so a message landing mid-pass is not lost to it.
   */
  pending: v.optional(
    v.object({
      gmail: v.optional(v.number()),
      calendar: v.optional(v.number()),
      chat: v.optional(v.number()),
    }),
  ),
  lastPushAt: v.optional(v.number()),
});
