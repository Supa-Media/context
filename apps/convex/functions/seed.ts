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
import { claimName, findName } from "./lib/nameClaims";
import { seedIngestionSettings } from "./lib/ingestionStore";
import { keyIfBornEmpty } from "./lib/noteIds/born";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/**
 * The personal workspace each texting persona answers from. `beta` is a reserved name, so its slug is `beta-preview`;
 * `alpha` and `delta` are the fixtures in `FIXTURES`. A texted link needs a personal workspace (`NO_PERSONAL_WORKSPACE`).
 */
const PREVIEW_PERSONAL = [
  { persona: "beta", slug: "beta-preview", name: "Beta Chen" },
  { persona: "gamma", slug: "gamma", name: "Gamma Ellis" },
] as const;

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

    // Phone links: each persona's number on its own account, as a number proven by text is linked. Each persona here
    // has a personal workspace above, which the product requires before it links a number.
    const alpha = await userByEmail(ctx, "alpha");
    await linkPhone(ctx, alpha, PREVIEW_PHONES.alpha, now);
    const allWorkspaces = workspaces.map(w => ({ slug: w.slug, workspaceId: w.workspaceId, owner: w.owner }));
    for (const { persona, slug, name } of PREVIEW_PERSONAL) {
      const userId = await userByEmail(ctx, persona);
      const workspaceId = await personalWorkspace(ctx, { userId, slug, name, now });
      allWorkspaces.push({ slug, workspaceId, owner: persona });
      await linkPhone(ctx, userId, PREVIEW_PHONES[persona], now);
    }

    return {
      workspaces: allWorkspaces,
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

async function userByEmail(ctx: MutationCtx, persona: string): Promise<Id<"users">> {
  const user = await ctx.db.query("users").withIndex("by_email", q => q.eq("email", `${persona}@supa.media`)).unique();
  if (user === null) throw new Error(`Preview seed: ${persona}'s account is missing.`);
  return user._id;
}

/** A persona's personal workspace, made once: found by its name claim, created with its owner membership if absent. */
async function personalWorkspace(
  ctx: MutationCtx,
  { userId, slug, name, now }: { userId: Id<"users">; slug: string; name: string; now: number },
): Promise<Id<"workspaces">> {
  const claim = await findName(ctx, slug);
  if (claim?.workspaceId) {
    const workspace = await ctx.db.get(claim.workspaceId);
    if (!workspace || workspace.createdBy !== userId || workspace.kind !== "personal") {
      throw new Error(`Preview seed: the name ${slug} is held by another workspace; nothing was changed.`);
    }
    return workspace._id;
  }
  const workspaceId = await ctx.db.insert("workspaces", {
    slug, displayName: name, createdBy: userId, kind: "personal", structureTemplate: "para", createdAt: now, updatedAt: now,
  });
  await claimName(ctx, slug, userId, { kind: "workspace", workspaceId });
  await ctx.db.insert("workspaceMembers", { workspaceId, userId, role: "owner", joinedAt: now });
  await seedIngestionSettings(ctx, { workspaceId, ownerUserId: userId, now });
  await keyIfBornEmpty(ctx, workspaceId);
  return workspaceId;
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
