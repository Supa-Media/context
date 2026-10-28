import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "./lib/crypto";
import { guestChatsOf, guestNote, guestPhoneHash } from "./lib/guestPhones";
import { phoneSignInPaused } from "./lib/emailProof";
import { normalizePhone } from "./lib/phoneCheck";
import { tryConsumeRateLimit } from "./lib/rateLimit";
import { readThroughShare } from "./lib/shares/readPath";
import { workspaceBySlug } from "./lib/textGroupInvited";
import { canTextCodes, checkCode, textCode } from "./phoneCodes";
import { phoneHolder } from "./phoneSignIn";

/**
 * A guest pass: opening a note from a Tex guest chat with a texted code, no account needed (the owner,
 * 2026-10-27; `docs/decisions/texting-assistant/guest-phone-pass.md`).
 *
 * Someone in a guest chat who has no account taps the note link Tex sent (`/note/@slug/<path>`). The page asks
 * for their number, texts it a code, and the code gives that browser a pass. The pass names the number (as its
 * hash, `lib/guestPhones.ts`) and nothing else: every read works out again which guest chats the number is in now,
 * and what those chats' groups can see, so leaving the chat, guest mode going off or the owner taking a note back
 * ends it on the next read.
 *
 *  - **A code goes only to a number in a live guest chat** of the workspace the link names. Any other number is
 *    texted nothing and gets the same answer, so this public action can't be used to text strangers, nor to ask
 *    whether a number is in a chat.
 *  - **Read only.** Edits still go through Tex in the chat. A note that is sealed, or comments on it, never reach
 *    the page: it reads through the share path with `openToAnyone`, as a link does.
 *  - **A number an account holds signs in for real** (the owner, 2026-10-27: "I should already be signed in"). It is
 *    texted the ordinary sign-in code, whichever chat it is in, members chats included, and the page signs in with
 *    `phone-verify`, landing on the note in the console with everything the account may see. Whether a number holds
 *    an account is already what the public sign-in page answers, so saying so here tells nobody anything new.
 *  - **One answer for every refusal** (`unavailable`): not shared with the chat, not there, not a note. A pass that
 *    is unknown or expired says `signed_out`, which is about the browser, not the note.
 */

/** How long a pass lasts from its last use. */
export const PASS_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** A pass's last use is written at most this often. */
const TOUCH_EVERY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
/** Codes texted to one phone per hour, shared with sign-in and the phone check. */
const SEND_PER_PHONE = 5;
/** Guest codes texted per hour, everybody together. */
const SEND_PER_HOUR = 300;
/** Numbers looked up per hour, everybody together. */
const LOOKUPS_PER_HOUR = 1000;
/** Sign-in codes texted per hour, everybody together, shared with the sign-in page (`phoneSignIn.ts`). */
const SIGN_IN_SEND_PER_HOUR = 300;
/** Codes typed for one phone per hour, right or wrong. */
const CHECK_PER_PHONE = 10;
/** Most passes one number holds; the oldest goes when a new one is made. */
const MAX_PASSES_PER_PHONE = 10;

const startStatus = v.union(
  v.literal("sent"),
  v.literal("invalid_phone"),
  v.literal("too_many"),
  v.literal("unavailable"),
  v.literal("failed"),
);

/**
 * Whether `phone` may be texted a code from the note page, spending one send when it may: `account` for a number an
 * account holds (a sign-in code), `ok` for one in a live guest chat of the workspace `slug` names (a guest code).
 */
export const reserveSend = internalMutation({
  args: { phone: v.string(), phoneHash: v.string(), slug: v.string() },
  returns: v.union(v.literal("account"), v.literal("ok"), v.literal("skip"), v.literal("too_many")),
  handler: async (ctx, { phone, phoneHash, slug }) => {
    if (!(await tryConsumeRateLimit(ctx, { key: "guestPass.lookup", limit: LOOKUPS_PER_HOUR, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    const holder = await phoneHolder(ctx, phone);
    // Paused by "This wasn't me": no sign-in code, but a guest code can still open what the chat shares.
    if (holder !== null && !(await phoneSignInPaused(ctx, holder))) {
      if (!(await tryConsumeRateLimit(ctx, { key: `phoneCheck.sendTo:${phone}`, limit: SEND_PER_PHONE, windowMs: WINDOW_MS }))) {
        return "too_many";
      }
      if (!(await tryConsumeRateLimit(ctx, { key: "phoneSignIn.send", limit: SIGN_IN_SEND_PER_HOUR, windowMs: WINDOW_MS }))) {
        throw new ConvexError({ code: "RATE_LIMITED", message: "too_many" });
      }
      return "account";
    }
    const workspace = await workspaceBySlug(ctx, slug);
    if (workspace === null || (await guestChatsOf(ctx, phoneHash, workspace._id)).length === 0) return "skip";
    if (!(await tryConsumeRateLimit(ctx, { key: `phoneCheck.sendTo:${phone}`, limit: SEND_PER_PHONE, windowMs: WINDOW_MS }))) {
      return "too_many";
    }
    if (!(await tryConsumeRateLimit(ctx, { key: "guestPass.send", limit: SEND_PER_HOUR, windowMs: WINDOW_MS }))) {
      // Rolls back the other spends with it.
      throw new ConvexError({ code: "RATE_LIMITED", message: "too_many" });
    }
    return "ok";
  },
});

/**
 * Text a code to open a note link. `account` says the code signs in to an account (`phone-verify`), not a guest
 * pass. Every other number that isn't in a guest chat hears `sent` and is texted nothing.
 */
export const start = action({
  args: { phone: v.string(), slug: v.string() },
  returns: v.object({ status: startStatus, phone: v.optional(v.string()), account: v.optional(v.boolean()) }),
  handler: async (ctx, args): Promise<{ status: typeof startStatus.type; phone?: string; account?: boolean }> => {
    const phone = normalizePhone(args.phone);
    if (phone === null) return { status: "invalid_phone" };
    const phoneHash = await guestPhoneHash(phone);
    if (phoneHash === null || !canTextCodes()) return { status: "unavailable", phone };
    let reserved: "account" | "ok" | "skip" | "too_many";
    try {
      reserved = await ctx.runMutation(internal.functions.guestPass.reserveSend, { phone, phoneHash, slug: args.slug.trim().replace(/^@/, "").toLowerCase() });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "RATE_LIMITED") return { status: "too_many" };
      throw error;
    }
    if (reserved === "too_many") return { status: "too_many" };
    if (reserved === "skip") return { status: "sent", phone };
    const sent = await textCode(ctx, phone);
    if (sent.ok) return reserved === "account" ? { status: "sent", phone, account: true } : { status: "sent", phone };
    return { status: sent.reason === "invalid_phone" ? "invalid_phone" : sent.reason === "too_many" ? "too_many" : "failed", phone };
  },
});

/** Spend one code check for `phone`. */
export const spendCheck = internalMutation({
  args: { phone: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phone }) =>
    await tryConsumeRateLimit(ctx, { key: `guestPass.check:${phone}`, limit: CHECK_PER_PHONE, windowMs: WINDOW_MS }),
});

/** Keep a new pass for a number that just proved itself and is in a guest chat; `false` when it is in none. */
export const issue = internalMutation({
  args: { phoneHash: v.string(), tokenHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { phoneHash, tokenHash }) => {
    if ((await guestChatsOf(ctx, phoneHash)).length === 0) return false;
    const held = await ctx.db
      .query("guestPasses")
      .withIndex("by_phone_hash", (q) => q.eq("phoneHash", phoneHash))
      .take(MAX_PASSES_PER_PHONE + 5);
    held.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const old of held.slice(0, Math.max(0, held.length - MAX_PASSES_PER_PHONE + 1))) await ctx.db.delete(old._id);
    const now = Date.now();
    await ctx.db.insert("guestPasses", { tokenHash, phoneHash, createdAt: now, lastUsedAt: now, expiresAt: now + PASS_LIFETIME_MS });
    // Expired passes of anyone are swept a few at a time as passes are made.
    for (const stale of await ctx.db
      .query("guestPasses")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20)) {
      await ctx.db.delete(stale._id);
    }
    return true;
  },
});

/** Check the texted code and hand this browser a pass. The pass is returned once and kept here only as a hash. */
export const verify = action({
  args: { phone: v.string(), code: v.string() },
  returns: v.object({
    status: v.union(v.literal("ok"), v.literal("wrong"), v.literal("too_many"), v.literal("unavailable")),
    pass: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ status: "ok" | "wrong" | "too_many" | "unavailable"; pass?: string }> => {
    const phone = normalizePhone(args.phone);
    if (phone === null || !/^\d{6}$/.test(args.code)) return { status: "wrong" };
    const phoneHash = await guestPhoneHash(phone);
    if (phoneHash === null) return { status: "unavailable" };
    if (!(await ctx.runMutation(internal.functions.guestPass.spendCheck, { phone }))) return { status: "too_many" };
    const checked = await checkCode(ctx, phone, args.code);
    if (checked === "too_many") return { status: "too_many" };
    if (checked !== "approved") return { status: "wrong" };
    const pass = newPass();
    const issued = await ctx.runMutation(internal.functions.guestPass.issue, { phoneHash, tokenHash: await hashToken(pass) });
    return issued ? { status: "ok", pass } : { status: "unavailable" };
  },
});

/** 32 random bytes, base64url. */
function newPass(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The number a live pass names, its last use written now and then. `null` for an unknown or expired pass. */
export const usePass = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("guestPasses")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    const now = Date.now();
    if (row === null || row.expiresAt <= now) return null;
    if (now - row.lastUsedAt > TOUCH_EVERY_MS) await ctx.db.patch(row._id, { lastUsedAt: now, expiresAt: now + PASS_LIFETIME_MS });
    return row.phoneHash;
  },
});

/** The note this number may read, and the names to read it by, or `null` for every refusal. */
export const authorizeRead = internalQuery({
  args: { phoneHash: v.string(), slug: v.string(), path: v.string() },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces"), path: v.string(), names: v.array(v.string()) })),
  handler: async (ctx, { phoneHash, slug, path }) => {
    const workspace = await workspaceBySlug(ctx, slug);
    if (workspace === null) return null;
    const note = await guestNote(ctx, phoneHash, workspace._id, path);
    return note === null ? null : { workspaceId: workspace._id, ...note };
  },
});

const readReturns = v.union(
  v.object({ status: v.literal("ok"), path: v.string(), text: v.string() }),
  v.object({ status: v.literal("signed_out") }),
  v.object({ status: v.literal("unavailable") }),
);

/** Read one note with a pass: only a note the guest chats this number is in can see. */
export const readNote = action({
  args: { pass: v.string(), slug: v.string(), path: v.string() },
  returns: readReturns,
  handler: async (ctx, args): Promise<typeof readReturns.type> => {
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(args.pass)) return { status: "signed_out" };
    const phoneHash = await ctx.runMutation(internal.functions.guestPass.usePass, { tokenHash: await hashToken(args.pass) });
    if (phoneHash === null) return { status: "signed_out" };
    const slug = args.slug.trim().replace(/^@/, "").toLowerCase();
    const note = await ctx.runQuery(internal.functions.guestPass.authorizeRead, { phoneHash, slug, path: args.path });
    if (note === null) return { status: "unavailable" };
    try {
      // `openToAnyone`: a guest has no key, so a sealed note is refused, as it is through a link.
      const read = await readThroughShare(ctx, note.workspaceId as Id<"workspaces">, note.path, null, true, "team", note.names);
      return { status: "ok", path: note.path, text: read.text };
    } catch (error) {
      const code = error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined;
      if (code === "NOT_AUTHENTICATED" || code === "SHARE_UNAVAILABLE") return { status: "unavailable" };
      throw error;
    }
  },
});

/** Forget a pass: "Sign out" on the page. */
export const signOut = action({
  args: { pass: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (/^[A-Za-z0-9_-]{40,64}$/.test(args.pass)) await ctx.runMutation(internal.functions.guestPass.dropPass, { tokenHash: await hashToken(args.pass) });
    return null;
  },
});

export const dropPass = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("guestPasses")
      .withIndex("by_token", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    return null;
  },
});
