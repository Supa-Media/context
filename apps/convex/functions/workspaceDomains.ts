import { getAuthUserId } from "@convex-dev/auth/server";
import { requireAuthId } from "@supa-media/convex/auth";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { clearGroupNames } from "./lib/workspaces/groupNames";
import { domainOf, isPersonalMailDomain, normalizeDomain } from "./lib/emailDomains";
import { myDomains } from "./lib/domainMembership";
import { getMembership, requireWorkspaceRole, workspaceNotFound } from "./lib/workspaceAuth";

/**
 * A shared workspace opened to everyone at an email domain (Dev2, 2026-10-09,
 * boards s3/s4; decision in `docs/decisions/identity-and-access.md`).
 *
 * The owner adds a domain they sign in with themselves, and picks what the
 * people joining that way can do (Can read by default). Somebody with a
 * confirmed address at the domain — their main one or one added on Account
 * settings — joins when they open a link to the workspace. They leave when
 * they stop signing in with any address there. To everybody else the
 * workspace answers exactly as it did before: it does not exist.
 */

/** More than any organization needs; keeps every walk below bounded. */
export const MAX_DOMAINS_PER_WORKSPACE = 10;
/** Workspaces one domain can open; bounds the lookup at sign-in. */
const MAX_WORKSPACES_PER_DOMAIN = 100;
/** Bounds the "N people joined this way" count. */
const COUNT_LIMIT = 1000;

const roleValidator = v.union(v.literal("editor"), v.literal("member"));

function refuse(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

async function domainRow(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  domain: string,
): Promise<Doc<"workspaceDomains"> | null> {
  const rows = await ctx.db
    .query("workspaceDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .take(MAX_DOMAINS_PER_WORKSPACE + 1);
  return rows.find((row) => row.domain === domain) ?? null;
}

async function requireSharedOwner(ctx: QueryCtx, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  const { workspace } = await requireWorkspaceRole(ctx, workspaceId, userId, "owner");
  // A personal workspace is one person's; there is nobody to open it to.
  if (workspace.kind !== "shared") refuse("NOT_SHARED", "Only a shared workspace can be opened to a domain");
  return workspace;
}

// ── The owner's card ───────────────────────────────────────────────────────

/** Settings › Sharing › Your organization: the domains, and the ones that could be added. */
export const listWorkspaceDomains = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    domains: v.array(
      v.object({ domain: v.string(), role: roleValidator, enabled: v.boolean(), joined: v.number() }),
    ),
    offer: v.array(
      v.object({
        domain: v.string(),
        email: v.string(),
        status: v.union(v.literal("ok"), v.literal("added"), v.literal("personal")),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireSharedOwner(ctx, args.workspaceId, userId);
    const rows = await ctx.db
      .query("workspaceDomains")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_DOMAINS_PER_WORKSPACE);
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(COUNT_LIMIT);
    const domains = rows.map((row) => ({
      domain: row.domain,
      role: row.role,
      enabled: row.enabled,
      joined: members.filter((member) => member.viaDomain === row.domain).length,
    }));
    const added = new Set(rows.map((row) => row.domain));
    const offer = [...(await myDomains(ctx, userId))].map(([domain, email]) => ({
      domain,
      email,
      status: added.has(domain) ? ("added" as const) : isPersonalMailDomain(domain) ? ("personal" as const) : ("ok" as const),
    }));
    return { domains, offer };
  },
});

export const addWorkspaceDomain = mutation({
  args: { workspaceId: v.id("workspaces"), domain: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireSharedOwner(ctx, args.workspaceId, userId);
    const domain = normalizeDomain(args.domain);
    if (domain === null) refuse("INVALID_DOMAIN", "Not a domain");
    if (isPersonalMailDomain(domain)) refuse("PERSONAL_DOMAIN", "Personal email services can't be added");
    // Only a domain the owner proves they hold an address at.
    if (!(await myDomains(ctx, userId)).has(domain)) {
      refuse("NOT_YOUR_DOMAIN", "You can only add a domain you sign in with");
    }
    const rows = await ctx.db
      .query("workspaceDomains")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_DOMAINS_PER_WORKSPACE + 1);
    if (rows.some((row) => row.domain === domain)) return null;
    if (rows.length >= MAX_DOMAINS_PER_WORKSPACE) refuse("TOO_MANY_DOMAINS", "Too many domains");
    await ctx.db.insert("workspaceDomains", {
      workspaceId: args.workspaceId,
      domain,
      role: "member",
      enabled: true,
      addedBy: userId,
      addedAt: Date.now(),
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "domain.added",
      details: { domain, role: "member" },
    });
    return null;
  },
});

/** The switch and the role. Off stops new joins; the people already in stay. */
export const updateWorkspaceDomain = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    domain: v.string(),
    enabled: v.optional(v.boolean()),
    role: v.optional(roleValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireSharedOwner(ctx, args.workspaceId, userId);
    const row = await domainRow(ctx, args.workspaceId, normalizeDomain(args.domain) ?? "");
    if (row === null) refuse("NOT_FOUND", "That domain isn't on this workspace");
    const patch = {
      ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
      ...(args.role === undefined ? {} : { role: args.role }),
    };
    await ctx.db.patch(row._id, patch);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "domain.updated",
      details: { domain: row.domain, ...patch },
    });
    return null;
  },
});

export const removeWorkspaceDomain = mutation({
  args: { workspaceId: v.id("workspaces"), domain: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireSharedOwner(ctx, args.workspaceId, userId);
    const row = await domainRow(ctx, args.workspaceId, normalizeDomain(args.domain) ?? "");
    if (row === null) return null;
    await ctx.db.delete(row._id);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "domain.removed",
      details: { domain: row.domain },
    });
    return null;
  },
});

// ── Joining ────────────────────────────────────────────────────────────────

/** The open domain rows a person's addresses reach, in workspaces they are not in yet. */
async function joinableFor(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Array<{ row: Doc<"workspaceDomains">; workspace: Doc<"workspaces"> }>> {
  const found: Array<{ row: Doc<"workspaceDomains">; workspace: Doc<"workspaces"> }> = [];
  const seen = new Set<string>();
  for (const domain of (await myDomains(ctx, userId)).keys()) {
    if (isPersonalMailDomain(domain)) continue;
    const rows = await ctx.db
      .query("workspaceDomains")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .take(MAX_WORKSPACES_PER_DOMAIN);
    for (const row of rows) {
      if (!row.enabled || seen.has(row.workspaceId)) continue;
      const workspace = await ctx.db.get(row.workspaceId);
      if (workspace === null || workspace.kind !== "shared") continue;
      if ((await getMembership(ctx, row.workspaceId, userId)) !== null) continue;
      seen.add(row.workspaceId);
      found.push({ row, workspace });
    }
  }
  return found;
}

/** Workspaces this person may join with their email domain. */
export const myDomainWorkspaces = query({
  args: {},
  returns: v.array(v.object({ slug: v.string(), name: v.string(), domain: v.string() })),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return [];
    return (await joinableFor(ctx, userId)).map(({ row, workspace }) => ({
      slug: workspace.slug,
      name: workspace.displayName,
      domain: row.domain,
    }));
  },
});

/**
 * Join `slug` through a domain. Anything that does not let this person in —
 * no such workspace, no domain, switched off, a personal one — is the same
 * "not found", so nobody can learn which workspaces are open to which domain.
 */
export const joinWithDomain = mutation({
  args: { slug: v.string() },
  returns: v.object({ slug: v.string(), name: v.string(), domain: v.string(), role: v.string() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const slug = args.slug.replace(/^@/, "").toLowerCase();
    const match = (await joinableFor(ctx, userId)).find(({ workspace }) => workspace.slug === slug);
    if (match === undefined) throw workspaceNotFound();
    const { row, workspace } = match;
    // A rejoin starts from no group names, as an accepted invitation does.
    await clearGroupNames(ctx, workspace._id, userId);
    await ctx.db.insert("workspaceMembers", {
      workspaceId: workspace._id,
      userId,
      role: row.role,
      joinedAt: Date.now(),
      viaDomain: row.domain,
    });
    await recordAudit(ctx, {
      workspaceId: workspace._id,
      actorUserId: userId,
      action: "member.joined",
      details: { role: row.role, viaDomain: row.domain },
    });
    return { slug: workspace.slug, name: workspace.displayName, domain: row.domain, role: row.role };
  },
});
