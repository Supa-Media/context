/**
 * The seed of a per-branch preview deployment (`docs/decisions/testing/preview-environments.md`).
 *
 * Run as `convex deploy --preview-run functions/seed:preview`. It makes the persona fixtures
 * (`lib/personaSeed.ts`, the same rows the staging seed makes), a few folders in one shared workspace, and the
 * phone link the post-deploy smoke test texts from. Nothing here writes a note body: bodies live in the
 * workspace's object, so `scripts/preview-seed.mjs` writes them after the deploy. Nothing here is a secret,
 * and nothing is a real phone number.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./lib/rowWatch/mutations";
import { isIsolatedPreview } from "./lib/previewDeployment";
import { seedPersonaWorkspaces } from "./lib/personaSeed";
import { insertFolder } from "./lib/nodes/rowMove";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** The simulator's numbers (`apps/agent/src/simulator.ts`): +1 212 555 01XX, never a real line. */
export const PREVIEW_PHONES = {
  alpha: "+12125550101",
  beta: "+12125550102",
  gamma: "+12125550103",
} as const;

/** Folders made in the shared team workspace, outermost first, so each parent exists before its child. */
const PREVIEW_FOLDERS = ["projects", "projects/launch"] as const;
/** The shared team workspace the folders go in. */
const FOLDER_WORKSPACE_SLUG = "lumio";

export const preview = internalMutation({
  args: {},
  returns: v.object({
    workspaces: v.array(v.object({ slug: v.string(), workspaceId: v.id("workspaces"), owner: v.string() })),
    phones: v.object({ alpha: v.string(), beta: v.string(), gamma: v.string() }),
    groupChat: v.null(),
  }),
  handler: async (ctx) => {
    if (!isIsolatedPreview()) throw new Error("seed:preview runs only on a preview deployment.");
    const now = Date.now();

    const { workspaces } = await seedPersonaWorkspaces(ctx, {});

    // Folders in the shared team workspace. A folder that already exists (live, not gone) is left as it is.
    const team = workspaces.find(w => w.slug === FOLDER_WORKSPACE_SLUG);
    if (!team) throw new Error(`Preview seed: the ${FOLDER_WORKSPACE_SLUG} fixture is missing.`);
    for (const path of PREVIEW_FOLDERS) {
      const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
      const parent = parentPath === null ? null : await liveFolder(ctx, team.workspaceId, parentPath);
      if (parentPath !== null && parent === null) throw new Error(`Preview seed: parent folder ${parentPath} is missing.`);
      if (await liveFolder(ctx, team.workspaceId, path) === null) {
        await insertFolder(ctx, team.workspaceId, path, parent?._id, now);
      }
    }

    // Phone links. Alpha's number is linked to alpha's account, as a text-proven link would be. Only alpha has a
    // personal workspace in the fixtures, and the product will not link a number to an account without one, so
    // beta's and gamma's numbers are reserved here and not linked (see the report).
    const alpha = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", "alpha@supa.media")).unique();
    if (alpha === null) throw new Error("Preview seed: alpha's account is missing.");
    await linkPhone(ctx, alpha._id, PREVIEW_PHONES.alpha, now);

    return {
      workspaces: workspaces.map(w => ({ slug: w.slug, workspaceId: w.workspaceId, owner: w.owner })),
      phones: { ...PREVIEW_PHONES },
      // A group chat is born from the first text its members send Tex, which carries the carrier's group id.
      // Nothing here can make that row without faking it, so the smoke script creates the chat by texting.
      groupChat: null,
    };
  },
});

async function liveFolder(ctx: MutationCtx, workspaceId: Id<"workspaces">, path: string): Promise<Doc<"nodes"> | null> {
  const rows = await ctx.db
    .query("nodes")
    .withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", path))
    .collect();
  return rows.find((row) => row.kind === "folder" && row.goneAt === undefined) ?? null;
}

async function linkPhone(ctx: MutationCtx, userId: Id<"users">, phone: string, now: number): Promise<void> {
  const existing = await ctx.db.query("phoneLinks").withIndex("by_phone", (q) => q.eq("phone", phone)).collect();
  if (existing.some((row) => row.userId === userId)) return;
  if (existing.length > 0) {
    throw new ConvexError({ code: "PHONE_HELD", message: "Preview seed: a fixture number is already linked to another account." });
  }
  // The same row `textLinks.consumeLinkCode` and `textSetup` write for a number proven by text.
  await ctx.db.insert("phoneLinks", { userId, phone, linkedAt: now, via: "text" });
}
