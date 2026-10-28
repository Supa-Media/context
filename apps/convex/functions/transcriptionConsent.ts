/**
 * Cloud transcription consent, kept on the account
 * (`docs/decisions/meetings/transcription-consent.md`).
 *
 * The person's own yes or no to sending recording audio to Cloudflare Workers
 * AI, with the disclosure version it answered. Every function that takes a
 * person names no user: the caller is the only key, so nobody can read or
 * change another account's answer. The two internal functions are what the
 * transcription boundaries ask (`meetings/transcribe.ts`, and the gateway
 * through `POST /gateway/transcription/consent`) before any audio is
 * forwarded.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import {
  CLOUD_TRANSCRIPTION_CONSENT_VERSION,
  CLOUD_TRANSCRIPTION_DISCLOSURE,
  isCurrentTranscriptionConsent,
} from "@context/shared";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalQuery, mutation, query } from "../_generated/server";
import { resolveGrantByAccessTokenHandler } from "./lib/controlPlane/session";
import { consumeRateLimit } from "./lib/rateLimit";
import { TEXTS_CLIENT_ID } from "./textLinks";

/** Generous for somebody flicking a switch, small for a client stuck in a loop. */
const WRITES_PER_HOUR = 60;
const CONSENT_WINDOW_MS = 60 * 60 * 1000;

async function rowFor(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("transcriptionConsents")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
}

/** Whether this account's stored answer is a yes to the current disclosure. */
export async function hasCurrentTranscriptionConsent(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  return isCurrentTranscriptionConsent(await rowFor(ctx, userId));
}

const answerShape = v.object({
  /** A yes to the disclosure this deployment shows now. */
  allowed: v.boolean(),
  /** The version the stored answer was given to, or null when there is none. */
  answeredVersion: v.union(v.number(), v.null()),
  /** The version this deployment asks for. */
  currentVersion: v.number(),
  /** A yes given to an older disclosure: asked again, never carried over. */
  outdated: v.boolean(),
  grantedAt: v.union(v.number(), v.null()),
  withdrawnAt: v.union(v.number(), v.null()),
  /** Whose answer this is: a device keeps an unconfirmed Turn off under it. */
  account: v.string(),
});

/** The caller's answer, or null when signed out. */
export const myTranscriptionConsent = query({
  args: {},
  returns: v.union(answerShape, v.null()),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const row = await rowFor(ctx, userId);
    return {
      allowed: isCurrentTranscriptionConsent(row),
      answeredVersion: row?.version ?? null,
      currentVersion: CLOUD_TRANSCRIPTION_CONSENT_VERSION,
      outdated: row !== null && row.withdrawnAt === undefined && row.version !== CLOUD_TRANSCRIPTION_CONSENT_VERSION,
      grantedAt: row?.grantedAt ?? null,
      withdrawnAt: row?.withdrawnAt ?? null,
      account: userId,
    };
  },
});

/**
 * Say yes, to the disclosure the caller was shown.
 *
 * `version` is the one on the dialog the person read. An app older than this
 * deployment shows older words, so its yes is refused rather than recorded
 * against a disclosure the person never saw.
 */
export const allowTranscription = mutation({
  args: { version: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    if (args.version !== CLOUD_TRANSCRIPTION_CONSENT_VERSION) {
      throw new ConvexError({
        code: "DISCLOSURE_OUTDATED",
        message: "What cloud transcription uses has changed. Update the app and read the new disclosure first.",
      });
    }
    await consumeRateLimit(ctx, { key: `transcription.consent:${userId}`, limit: WRITES_PER_HOUR, windowMs: CONSENT_WINDOW_MS });
    const now = Date.now();
    const row = await rowFor(ctx, userId);
    const fields = {
      version: CLOUD_TRANSCRIPTION_CONSENT_VERSION,
      provider: CLOUD_TRANSCRIPTION_DISCLOSURE.provider,
      grantedAt: now,
      withdrawnAt: undefined,
      updatedAt: now,
    };
    if (row === null) await ctx.db.insert("transcriptionConsents", { userId, ...fields });
    else await ctx.db.patch(row._id, fields);
    return null;
  },
});

/** Say no. Every boundary refuses this account's audio from the next chunk on. */
export const withdrawTranscription = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await consumeRateLimit(ctx, { key: `transcription.consent:${userId}`, limit: WRITES_PER_HOUR, windowMs: CONSENT_WINDOW_MS });
    const row = await rowFor(ctx, userId);
    // Nothing to withdraw is not an error: the answer is already no.
    if (row === null || row.withdrawnAt !== undefined) return null;
    const now = Date.now();
    await ctx.db.patch(row._id, { withdrawnAt: now, updatedAt: now });
    return null;
  },
});

/** For `meetings/transcribe.ts`: may this account's audio be sent now? */
export const hasConsent = internalQuery({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, args) => await hasCurrentTranscriptionConsent(ctx, args.userId),
});

/**
 * For the gateway: may audio arriving on this token be sent now?
 *
 * The person comes off the token's live grant, never from anything the
 * gateway names, and the grant must reach `expectedWorkspaceId`. A voice
 * message counts only on Tex's one-person texting grant. Every
 * refusal, a dead token included, is the same `false`.
 */
export const gatewayConsent = internalQuery({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.string(),
    kind: v.union(v.literal("meeting"), v.literal("voiceMessage")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
    if (session === null) return false;
    // A voice message is heard only on a one-person texting grant, whose
    // person is the one who sent it. A group chat's grant speaks for several
    // people, and one member's yes is never anybody else's.
    if (args.kind === "voiceMessage" && session.clientId !== TEXTS_CLIENT_ID) return false;
    if (!session.workspaces.some((entry) => entry.workspaceId === args.expectedWorkspaceId)) return false;
    return await hasCurrentTranscriptionConsent(ctx, session.actorUserId as Id<"users">);
  },
});
