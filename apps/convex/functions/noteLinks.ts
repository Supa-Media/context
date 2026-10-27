import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { authorizeGrant } from "./lib/grants/outsider";
import { workspaceBySlug } from "./lib/textGroupInvited";
import { getMembership } from "./lib/workspaceAuth";

/**
 * Where a `/note/@slug/<path>` link opens for the signed-in caller (`apps/mobile/app/note/[...address].tsx`).
 *
 * The console address only opens notes in a workspace the caller is a member of; anyone else landed on their own
 * home with no word about the note (the owner, 2026-10-27: a guest with an account tapped a note link from a Tex
 * WhatsApp guest chat and saw his own workspace). Someone who isn't a member but was named on the note's row, or a
 * folder above it, reads it where every outsider grant opens: `@shared` (`lib/shares/grantedRead.ts`).
 *
 *  - `member`: the console address, as before, which also handles a note that isn't there.
 *  - `granted`: the outsider view, at the path the grant resolved.
 *  - `none`: one answer for not granted, not there and no such workspace, so a link can't be used to ask whether
 *    a note exists in a workspace the caller can't see.
 */
export const target = query({
  args: { slug: v.string(), path: v.string() },
  returns: v.union(
    v.object({ kind: v.literal("member") }),
    v.object({ kind: v.literal("granted"), workspaceId: v.id("workspaces"), path: v.string() }),
    v.object({ kind: v.literal("none") }),
    v.object({ kind: v.literal("signed_out") }),
  ),
  handler: async (ctx, args) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return { kind: "signed_out" as const };
    const workspace = await workspaceBySlug(ctx, args.slug.trim().replace(/^@/, "").toLowerCase());
    if (workspace === null) return { kind: "none" as const };
    if ((await getMembership(ctx, workspace._id, userId)) !== null) return { kind: "member" as const };
    const grant = await authorizeGrant(ctx, { userId, workspaceId: workspace._id, path: args.path });
    if (grant === null || grant.kind !== "file") return { kind: "none" as const };
    return { kind: "granted" as const, workspaceId: workspace._id, path: grant.path };
  },
});
