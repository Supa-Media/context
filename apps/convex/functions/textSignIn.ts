import { v } from "convex/values";
import { action, type ActionCtx, type MutationCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { personalWorkspaceOf } from "./textLinks";

/**
 * A ten-digit code that signs `userId` in through `phone-verify`, for a page that has just proved `phone` with a texted
 * code and was made the account itself (`guestPass.ts`, the owner, 2026-10-31). The page then signs in exactly as a
 * number an account holds does: the provider checks this code, `signInUser` names the holder, and the session is the
 * library's. The row has no link to open, so its token is random and never sent; it is spent by the code like any
 * other, and lives the code's five minutes.
 */
export async function mintPhoneSignInCode(ctx: MutationCtx, userId: Id<"users">, phone: string): Promise<string> {
  const code = newLinkCode();
  const now = Date.now();
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  await ctx.db.insert("textSignInLinks", {
    userId,
    phone,
    tokenHash: await hashToken(token),
    next: "/",
    expiresAt: now + SIGN_IN_LINK_TTL_MS,
    openedAt: now,
    codeHash: await hashToken(code),
    codeExpiresAt: now + SIGN_IN_CODE_TTL_MS,
  });
  return code;
}

/**
 * The link Tex texts once somebody's notes are ready, which signs them in
 * (Dev2, 2026-10-18: "since it's coming from that number already, then it's
 * pre-authenticated, and then they just go to what's your email immediately").
 *
 * Somebody set up by text has never signed in to the app, and the first thing
 * Tex sends them to is the app, to connect Google. A phone code there proves
 * the phone a second time: the link is texted to the phone that set itself up,
 * through the same line Apple authenticates its sender on, so the link is that
 * proof. What the link may do is kept as narrow as a texted code:
 *
 *  - It signs in only the account holding the phone it was texted to, through
 *    the same `phone-verify` provider a code uses, so every refusal there
 *    (paused phone sign-in, a phone that changed hands) still applies.
 *  - It is opened once, within a day. Opening it mints a ten-digit code that
 *    lives five minutes, which the page signs in with at once. The code is not
 *    the six-digit kind, so it never meets a texted code's records.
 *  - The token is 256 bits and only its hash is kept. The model never sees a
 *    link: the texting Worker asks for it and sends it (`apps/agent`).
 *  - Where it goes once signed in is built here, never taken from the link.
 *
 * Opening is a button-free page action, not the link itself, so a preview
 * that fetches the address without running the page spends nothing.
 */

export const SIGN_IN_LINK_ROUTE = "/signin";
export const SIGN_IN_LINK_TTL_MS = 24 * 60 * 60 * 1000;
export const SIGN_IN_CODE_TTL_MS = 5 * 60 * 1000;
/** The code an opening mints: ten digits, the most the provider takes, so never a texted code's six. */
export const SIGN_IN_CODE_LENGTH = 10;

const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/**
 * Whether `phone`'s notes are ready and, when they are, a fresh link's row.
 * Ready means the personal workspace's storage answers and its starting
 * folders are laid out (`lib/textSetup/layout.ts` deletes the `layout` row).
 * `gone` is a phone nobody links any more, or with no personal workspace.
 */
export const readyLink = internalMutation({
  args: { phone: v.string(), tokenHash: v.string() },
  returns: v.union(
    v.object({ status: v.literal("waiting") }),
    v.object({ status: v.literal("gone") }),
    v.object({ status: v.literal("ready"), next: v.string() }),
  ),
  handler: async (ctx, { phone, tokenHash }) => {
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (link === null) return { status: "gone" as const };
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    const workspace = workspaceId === null ? null : await ctx.db.get(workspaceId);
    if (workspace === null) return { status: "gone" as const };
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .first();
    if (binding?.status !== "connected") return { status: "waiting" as const };
    const layingOut = await ctx.db
      .query("textSetups")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .first();
    if (layingOut?.stage === "layout") return { status: "waiting" as const };
    const next = `/console/@${workspace.slug}?settings=integrations`;
    await ctx.db.insert("textSignInLinks", {
      userId: link.userId,
      phone,
      tokenHash,
      next,
      expiresAt: Date.now() + SIGN_IN_LINK_TTL_MS,
    });
    return { status: "ready" as const, next };
  },
});

type OpenAnswer = { status: "spent"; next?: string } | { status: "open"; phone: string; code: string; next: string };

const openAnswer = v.union(
  v.object({ status: v.literal("spent"), next: v.optional(v.string()) }),
  v.object({ status: v.literal("open"), phone: v.string(), code: v.string(), next: v.string() }),
);

/**
 * The page's one call: open the link in `token`. `open` hands back the phone
 * and a code to sign in with straight away; `spent` (opened before, expired,
 * or never issued) carries where it would have gone, when known, so the page
 * can send them to the ordinary sign-in on the way there.
 */
export const open = action({
  args: { token: v.string() },
  returns: openAnswer,
  handler: async (ctx, { token }): Promise<OpenAnswer> => {
    if (!TOKEN_SHAPE.test(token)) return { status: "spent" as const };
    const code = newLinkCode();
    const opened: { status: "spent"; next?: string } | { status: "open"; phone: string; next: string } =
      await ctx.runMutation(internal.functions.textSignIn.openByHash, {
        tokenHash: await hashToken(token),
        codeHash: await hashToken(code),
      });
    return opened.status === "open" ? { ...opened, code } : opened;
  },
});

export const openByHash = internalMutation({
  args: { tokenHash: v.string(), codeHash: v.string() },
  returns: v.union(
    v.object({ status: v.literal("spent"), next: v.optional(v.string()) }),
    v.object({ status: v.literal("open"), phone: v.string(), next: v.string() }),
  ),
  handler: async (ctx, { tokenHash, codeHash }) => {
    const row = await ctx.db
      .query("textSignInLinks")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .first();
    if (row === null) return { status: "spent" as const };
    const now = Date.now();
    if (row.openedAt !== undefined || row.expiresAt <= now) return { status: "spent" as const, next: row.next };
    await ctx.db.patch(row._id, { openedAt: now, codeHash, codeExpiresAt: now + SIGN_IN_CODE_TTL_MS });
    return { status: "open" as const, phone: row.phone, next: row.next };
  },
});

/**
 * Asked by `auth.ts` for a ten-digit code: `approved` once, for the phone the
 * link was texted to, within five minutes of opening; `wrong` otherwise.
 */
export const consumeCode = internalMutation({
  args: { phone: v.string(), codeHash: v.string() },
  returns: v.union(v.literal("approved"), v.literal("wrong")),
  handler: async (ctx, { phone, codeHash }) => {
    const now = Date.now();
    for (const row of await ctx.db
      .query("textSignInLinks")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .take(50)) {
      if (row.codeHash !== codeHash || (row.codeExpiresAt ?? 0) <= now) continue;
      await ctx.db.delete(row._id);
      return "approved" as const;
    }
    return "wrong" as const;
  },
});

/** `auth.ts`'s check for a ten-digit code, typed here so `auth.ts` stays out of `api`'s inference. */
export async function checkLinkCode(ctx: ActionCtx, phone: string, code: string): Promise<"approved" | "wrong"> {
  return await ctx.runMutation(internal.functions.textSignIn.consumeCode, { phone, codeHash: await hashToken(code) });
}

/** Hourly: links a day past their life, opened or not. */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - SIGN_IN_CODE_TTL_MS;
    for (const row of await ctx.db
      .query("textSignInLinks")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", cutoff))
      .take(200)) {
      await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Ten digits, leading zeros kept. */
export function newLinkCode(): string {
  const buffer = new Uint32Array(2);
  crypto.getRandomValues(buffer);
  // 2^64 is not a multiple of 10^10; the bias is under one part in 10^9.
  const value = (BigInt(buffer[0]!) << 32n) | BigInt(buffer[1]!);
  return (value % 10n ** BigInt(SIGN_IN_CODE_LENGTH)).toString().padStart(SIGN_IN_CODE_LENGTH, "0");
}
