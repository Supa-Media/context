import { getAuthUserId } from "./lib/signedIn";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalQuery, query, type QueryCtx } from "../_generated/server";
import { dedicatedTexLines, texLineFor } from "./lib/adminFns/texAllowlist";
import { currentPhoneOf } from "./lib/emailProof";
import { personalWorkspaceOf } from "./textLinks";

/**
 * What tex.lc's signed-in page and the Gmail-first pages need to know about
 * the signed-in person (Dev2, 2026-10-20): the Tex line to text, whether they
 * have ever texted it (so Open Messages can start them with "hi"), their main
 * email, and the Gmails their personal workspace reads. The person's own
 * facts only; the phone is shown by its last four digits.
 */

/** Gmail addresses the personal workspace reads, oldest connection first. */
export async function connectedGmailsOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<string[]> {
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(50);
  return rows
    .filter((row) => row.disconnectedAt === undefined && row.gmail !== undefined)
    .map((row) => row.address.toLowerCase());
}

/** Whether `phone` has ever reached Tex: a texting link, or a setup Tex started for it. */
export async function hasTextedTex(ctx: QueryCtx, phone: string): Promise<boolean> {
  const link = await ctx.db
    .query("phoneLinks")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  if (link !== null) return true;
  const setup = await ctx.db
    .query("textSetups")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
  return setup !== null;
}

const homeValidator = v.union(
  v.null(),
  v.object({
    /** The last four digits of the phone they sign in with, if any. */
    ending: v.union(v.string(), v.null()),
    /** The Tex line for that phone, when one is configured. */
    line: v.union(v.string(), v.null()),
    /** True until that phone first texts Tex. */
    firstText: v.boolean(),
    mainEmail: v.union(v.string(), v.null()),
    /** Their personal workspace, which a Gmail connects to. */
    workspaceId: v.union(v.id("workspaces"), v.null()),
    gmails: v.array(v.string()),
  }),
);

export const mine = query({
  args: {},
  returns: homeValidator,
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    const phone = await currentPhoneOf(ctx, user);
    const lines = dedicatedTexLines(process.env.TEX_LINE_NUMBERS);
    const workspaceId = await personalWorkspaceOf(ctx, userId);
    return {
      ending: phone === null ? null : phone.slice(-4),
      line: phone === null || lines.length === 0 ? null : texLineFor(lines, phone),
      firstText: phone === null ? true : !(await hasTextedTex(ctx, phone)),
      mainEmail: user.email?.toLowerCase() ?? null,
      workspaceId,
      gmails: workspaceId === null ? [] : await connectedGmailsOf(ctx, workspaceId),
    };
  },
});

/**
 * For the texting Worker, after it sent the "notes are ready" text: whether
 * the phone's personal workspace reads a Gmail yet, and whether that Gmail is
 * the account's main email. `gone` is a phone nobody links any more.
 */
export const gmailFor = internalQuery({
  args: { phone: v.string() },
  returns: v.union(
    v.object({ status: v.literal("waiting") }),
    v.object({ status: v.literal("gone") }),
    v.object({ status: v.literal("connected"), address: v.string(), main: v.boolean() }),
  ),
  handler: async (ctx, { phone }) => {
    const link = await ctx.db
      .query("phoneLinks")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (link === null) return { status: "gone" as const };
    const user = await ctx.db.get(link.userId);
    const workspaceId = await personalWorkspaceOf(ctx, link.userId);
    if (user === null || workspaceId === null) return { status: "gone" as const };
    const [first] = await connectedGmailsOf(ctx, workspaceId);
    if (first === undefined) return { status: "waiting" as const };
    return { status: "connected" as const, address: first, main: user.email?.toLowerCase() === first };
  },
});
