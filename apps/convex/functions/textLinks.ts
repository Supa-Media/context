import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import {
  SCOPE_PRIVATE,
  SCOPE_READ,
  SCOPE_WRITE,
  clampScopes,
  hasOperationScope,
} from "./lib/consentScopes";
import { hashToken } from "./lib/crypto";
import { consumeRateLimit } from "./lib/rateLimit";
import { getMembership } from "./lib/workspaceAuth";

/**
 * Linking a phone to an account, so the person can text the Context assistant.
 *
 * ## How a link is made, and why both halves are needed
 *
 * The sending number is the whole of a texter's identity (`apps/agent` only
 * answers iMessage, whose senders Apple authenticates). So a link proves two
 * things at once: the signed-in app asks for a code **for one number**, and the
 * link is made only when that code is texted **from that number**. Holding the
 * account alone, or the phone alone, links nothing.
 *
 * ## What a texted question can reach
 *
 * Exactly what any other connection of that person's reaches: the grant is
 * minted on their personal workspace, which is what an unaddressed question
 * answers from, and the gateway resolves the rest of its reach from their live
 * memberships, as it does for every grant. Group chats never get here
 * (`apps/agent/src/inbound.ts`), so an answer only ever goes back to the person
 * whose grant produced it.
 */

/** E.164: a plus, a non-zero country digit, 7 to 15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** No 0/O, 1/I/L: a code is read off a screen and typed on a phone. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_WRONG_TRIES = 5;

/** The client id texting grants are filed under, and what the person sees. */
export const TEXTS_CLIENT_ID = "context_texts";
const TEXTS_CLIENT_NAME = "Texts (iMessage)";

/**
 * A grant per text, short-lived. The Worker mints one for each message it
 * answers, so a grant only has to outlast one answer.
 */
export const TEXTS_GRANT_TTL_MS = 15 * 60 * 1000;
const TEXTS_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_PRIVATE];

/** Codes one person may ask for per hour. */
const START_LIMIT = 10;
/** Link attempts per phone per hour, right or wrong. */
const LINK_ATTEMPT_LIMIT = 10;
const START_LINK_WINDOW_MS = 60 * 60 * 1000;
const LINK_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

export function isPhoneNumber(value: string): boolean {
  return E164.test(value);
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  // 256 is not a multiple of 31, so this is very slightly biased toward the
  // first eight letters. Over 8 characters that costs well under a bit of
  // entropy, against a code that lives ten minutes and allows five tries.
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

async function personalWorkspaceOf(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Id<"workspaces"> | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(200);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace?.kind === "personal" && workspace.createdBy === userId) return workspace._id;
  }
  return null;
}

// ── The app's side ─────────────────────────────────────────────────────────

/**
 * Ask for a code to link `phone`. An action because hashing is Web Crypto; the
 * plaintext code goes back to the signed-in person and only its hash is kept.
 */
export const startPhoneLink = action({
  args: { phone: v.string() },
  returns: v.object({ code: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    }
    if (!isPhoneNumber(args.phone)) {
      throw new ConvexError({
        code: "INVALID_ARGUMENT",
        message: "Enter the number with its country code, like +15555550100.",
      });
    }
    const code = newCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    await ctx.runMutation(internal.functions.textLinks.storeLinkCode, {
      userId: userId as Id<"users">,
      phone: args.phone,
      hashedCode: await hashToken(code),
      expiresAt,
    });
    return { code, expiresAt };
  },
});

export const storeLinkCode = internalMutation({
  args: {
    userId: v.id("users"),
    phone: v.string(),
    hashedCode: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await consumeRateLimit(ctx, {
      key: `texts.startLink:${args.userId}`,
      limit: START_LIMIT,
      windowMs: START_LINK_WINDOW_MS,
    });
    if ((await personalWorkspaceOf(ctx, args.userId)) === null) {
      throw new ConvexError({
        code: "NO_PERSONAL_WORKSPACE",
        message: "Texting answers from your personal workspace, and this account has none.",
      });
    }
    // One live code per person: asking again replaces the last one.
    const previous = await ctx.db
      .query("phoneLinkCodes")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const row of previous) await ctx.db.delete(row._id);
    await ctx.db.insert("phoneLinkCodes", { ...args, wrongTries: 0 });
    return null;
  },
});

/** The number this person has linked, if any. Only ever their own. */
export const myPhoneLink = query({
  args: {},
  returns: v.union(v.null(), v.object({ phone: v.string(), linkedAt: v.number() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_user", (q) => q.eq("userId", userId as Id<"users">))
      .first();
    return link === null ? null : { phone: link.phone, linkedAt: link.linkedAt };
  },
});

/** Stop answering texts from this person's phone, and end any live grant. */
export const unlinkPhone = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    }
    await removeLinksOf(ctx, userId as Id<"users">, "texts.phone.unlinked");
    return null;
  },
});

async function removeLinksOf(ctx: MutationCtx, userId: Id<"users">, action: string) {
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const link of links) await ctx.db.delete(link._id);

  const grants = await ctx.db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const grant of grants) {
    if (grant.clientId === TEXTS_CLIENT_ID && grant.status === "active") {
      await ctx.db.patch(grant._id, { status: "revoked" });
    }
  }

  if (links.length > 0) {
    const workspaceId = await personalWorkspaceOf(ctx, userId);
    if (workspaceId !== null) {
      await recordAudit(ctx, { workspaceId, actorUserId: userId, action, details: {} });
    }
  }
}

// ── The Worker's side (reached only through `/agent-texts/*`) ──────────────

/**
 * Link `phone` if `hashedCode` is the code shown for it. Never throws for a
 * wrong code: the attempt has to count, and a throw would roll the count back.
 */
export const consumeLinkCode = internalMutation({
  args: { phone: v.string(), hashedCode: v.string() },
  returns: v.union(
    v.object({ status: v.literal("linked"), handle: v.string() }),
    v.object({ status: v.literal("refused") }),
  ),
  handler: async (ctx, args) => {
    const refused = { status: "refused" as const };
    if (!isPhoneNumber(args.phone)) return refused;
    try {
      await consumeRateLimit(ctx, {
        key: `texts.link:${args.phone}`,
        limit: LINK_ATTEMPT_LIMIT,
        windowMs: LINK_ATTEMPT_WINDOW_MS,
      });
    } catch {
      return refused;
    }

    const codes = await ctx.db
      .query("phoneLinkCodes")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .collect();
    const now = Date.now();
    const match = codes.find((row) => row.hashedCode === args.hashedCode && row.expiresAt > now);
    if (match === undefined) {
      for (const row of codes) {
        if (row.expiresAt <= now || row.wrongTries + 1 >= MAX_WRONG_TRIES) {
          await ctx.db.delete(row._id);
        } else {
          await ctx.db.patch(row._id, { wrongTries: row.wrongTries + 1 });
        }
      }
      return refused;
    }

    await ctx.db.delete(match._id);
    const personal = await personalWorkspaceOf(ctx, match.userId);
    const workspace = personal === null ? null : await ctx.db.get(personal);
    if (workspace === null) return refused;

    // A number belongs to one account. Linking it here moves it: whoever
    // texted the code holds the phone, which is the stronger claim.
    const existing = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .collect();
    for (const link of existing) {
      if (link.userId !== match.userId) {
        await removeLinksOf(ctx, link.userId, "texts.phone.moved");
      } else {
        await ctx.db.delete(link._id);
      }
    }
    // And an account has one number: a new one replaces the old.
    await removeLinksOf(ctx, match.userId, "texts.phone.replaced");
    await ctx.db.insert("phoneLinks", { userId: match.userId, phone: args.phone, linkedAt: now });

    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: match.userId,
      action: "texts.phone.linked",
      details: {},
    });
    // The handle goes back in the confirmation text, so whoever texted the
    // code sees whose Context the phone now answers from. Without it, someone
    // could make a code for *your* number on *their* account and talk you into
    // texting it, and your questions would quietly land in their notes.
    return { status: "linked" as const, handle: workspace.slug };
  },
});

/**
 * Mint a grant for whoever linked `phone`, on their personal workspace. The
 * token hashes come from the calling action; the plaintext never reaches here.
 */
export const applyTextsGrant = internalMutation({
  args: {
    phone: v.string(),
    hashedAccessToken: v.string(),
    hashedRefreshToken: v.string(),
    expiresAt: v.number(),
  },
  returns: v.union(v.literal("linked"), v.literal("unlinked")),
  handler: async (ctx, args) => {
    if (!isPhoneNumber(args.phone)) return "unlinked";
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", args.phone))
      .first();
    if (link === null) return "unlinked";
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (workspaceId === null) return "unlinked";

    const membership = await getMembership(ctx, workspaceId, link.userId);
    if (membership === null) return "unlinked";
    const scopes = clampScopes(TEXTS_SCOPES, membership.role);
    if (!hasOperationScope(scopes)) return "unlinked";

    await ensureTextsClient(ctx);

    // One live texting grant per person: each mint replaces the last token,
    // which revokes it in the same transaction.
    const grants = await ctx.db
      .query("oauthGrants")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", workspaceId).eq("userId", link.userId),
      )
      .collect();
    const reusable = grants.find((g) => g.clientId === TEXTS_CLIENT_ID && g.status === "active");
    const token = {
      scopes,
      hashedRefreshToken: args.hashedRefreshToken,
      hashedAccessToken: args.hashedAccessToken,
      accessTokenExpiresAt: args.expiresAt,
    };
    if (reusable === undefined) {
      await ctx.db.insert("oauthGrants", {
        workspaceId,
        userId: link.userId,
        clientId: TEXTS_CLIENT_ID,
        ...token,
        status: "active",
        createdAt: Date.now(),
      });
    } else {
      await ctx.db.patch(reusable._id, token);
    }
    await recordAudit(ctx, {
      workspaceId,
      actorUserId: link.userId,
      actorClientId: TEXTS_CLIENT_ID,
      action: "texts.session.opened",
      details: { scopes: scopes.join(" ") },
    });
    return "linked";
  },
});

async function ensureTextsClient(ctx: MutationCtx): Promise<void> {
  const existing = await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", TEXTS_CLIENT_ID))
    .unique();
  if (existing !== null) return;
  await ctx.db.insert("oauthClients", {
    clientId: TEXTS_CLIENT_ID,
    clientName: TEXTS_CLIENT_NAME,
    redirectUris: [],
    hashedClientSecret: null,
    tokenEndpointAuthMethod: "none",
    grantTypes: [],
    responseTypes: [],
    createdAt: Date.now(),
  });
}

/** Account deletion: links and pending codes go with the person. */
export async function deleteTextLinksOf(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  for (const table of ["phoneLinks", "phoneLinkCodes"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}
