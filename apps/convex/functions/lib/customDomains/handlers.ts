/**
 * The database half of custom domains: what the settings screen reads, what an
 * owner can do, and how a check's findings land on the row.
 *
 * Registered in `functions/customDomains.ts`. Everything that talks to DNS or
 * to Cloudflare is an internal action in `functions/customDomainsProvision.ts`,
 * reached only by a schedule edge from here — scheduling is not calling, so no
 * public function here is a path to the provider credential.
 */

import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { planFor, requireUserId, statusOf } from "../billing/plan";
import { planIsPaying } from "../premium";
import { shortLinkSlugFrom } from "../shareSlug";
import { isLive } from "../shares/standing";
import { roleAtLeast, requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { customDomainsDeployment } from "./config";
import { mintOwnershipToken, ownershipRecordName, ownershipRecordValue } from "./dns";
import { describeHostnameRejection, normalizeHostname, relativeRecordName } from "./hostname";
import {
  applyCheck,
  DOMAINS_PER_WORKSPACE,
  nextCheckDelay,
  stageOf,
  sweepActionFor,
  type CheckFindings,
} from "./lifecycle";

type Row = Doc<"customDomains">;

export async function workspacePaying(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<boolean> {
  return planIsPaying(statusOf(await planFor(ctx, workspaceId)));
}

async function domainForOwner(
  ctx: QueryCtx,
  domainId: Id<"customDomains">,
): Promise<{ row: Row; userId: Id<"users"> }> {
  const userId = await requireUserId(ctx);
  const row = await ctx.db.get(domainId);
  if (row === null) {
    throw new ConvexError({ code: "DOMAIN_NOT_FOUND", message: "That domain is no longer connected." });
  }
  // Membership first, so a non-member learns nothing about a row id they hold.
  await requireWorkspaceRole(ctx, row.workspaceId, userId, "owner");
  return { row, userId };
}

/* -------------------------------------------------------------------------- */
/* The settings screen                                                         */
/* -------------------------------------------------------------------------- */

export const dnsRecordValidator = v.object({
  purpose: v.union(v.literal("ownership"), v.literal("routing")),
  type: v.string(),
  /** Fully qualified. */
  name: v.string(),
  /** As most DNS providers' forms want it: `docs`, `_context.docs`, `@`. */
  host: v.string(),
  value: v.string(),
  done: v.boolean(),
});

export const domainViewValidator = v.object({
  id: v.id("customDomains"),
  hostname: v.string(),
  apex: v.boolean(),
  status: v.union(
    v.literal("pending"),
    v.literal("active"),
    v.literal("suspended"),
    v.literal("removing"),
  ),
  stage: v.union(v.literal("ownership"), v.literal("routing"), v.literal("https"), v.literal("live")),
  ownershipVerified: v.boolean(),
  routingVerified: v.boolean(),
  httpsReady: v.boolean(),
  problem: v.union(v.string(), v.null()),
  homeSlug: v.union(v.string(), v.null()),
  checkedAt: v.union(v.number(), v.null()),
  /** Owner only: the records to add. Empty for anybody else. */
  records: v.array(dnsRecordValidator),
});

export const settingsValidator = v.object({
  /** This deployment serves customer domains at all. */
  available: v.boolean(),
  paying: v.boolean(),
  canManage: v.boolean(),
  domain: v.union(domainViewValidator, v.null()),
});

export type DomainSettings = Infer<typeof settingsValidator>;

function recordsFor(row: Row, target: string): Infer<typeof dnsRecordValidator>[] {
  const ownershipName = ownershipRecordName(row.hostname);
  return [
    {
      purpose: "routing",
      type: row.apex ? "ALIAS" : "CNAME",
      name: row.hostname,
      host: relativeRecordName(row.hostname, row.hostname),
      value: target,
      done: row.routingVerified,
    },
    {
      purpose: "ownership",
      type: "TXT",
      name: ownershipName,
      host: relativeRecordName(ownershipName, row.hostname),
      value: ownershipRecordValue(row.verifyToken),
      done: row.ownershipVerified,
    },
  ];
}

export async function settingsHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<DomainSettings> {
  const userId = await requireUserId(ctx);
  const { membership } = await requireWorkspaceAccess(ctx, args.workspaceId, userId);
  const canManage = roleAtLeast(membership.role, "owner");
  const deployment = customDomainsDeployment();
  const paying = await workspacePaying(ctx, args.workspaceId);
  const row = await ctx.db
    .query("customDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .first();
  return {
    available: deployment !== null,
    paying,
    canManage,
    domain:
      row === null
        ? null
        : {
            id: row._id,
            hostname: row.hostname,
            apex: row.apex,
            status: row.status,
            stage: stageOf(row),
            ownershipVerified: row.ownershipVerified,
            routingVerified: row.routingVerified,
            httpsReady: row.httpsReady,
            problem: row.problem ?? null,
            homeSlug: row.homeSlug ?? null,
            checkedAt: row.checkedAt ?? null,
            records: canManage && deployment !== null ? recordsFor(row, deployment.target) : [],
          },
  };
}

/* -------------------------------------------------------------------------- */
/* Owner actions                                                               */
/* -------------------------------------------------------------------------- */

export async function connectHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; hostname: string },
): Promise<Id<"customDomains">> {
  const userId = await requireUserId(ctx);
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  if (customDomainsDeployment() === null) {
    throw new ConvexError({
      code: "NOT_CONFIGURED",
      message: "Custom domains aren't available on this deployment yet.",
    });
  }
  if (!(await workspacePaying(ctx, args.workspaceId))) {
    throw new ConvexError({
      code: "PREMIUM_REQUIRED",
      message: "Custom domains are part of Premium.",
    });
  }

  const normalized = normalizeHostname(args.hostname);
  if (!normalized.ok) {
    throw new ConvexError({
      code: "INVALID_HOSTNAME",
      message: describeHostnameRejection(normalized.reason),
    });
  }

  const existing = await ctx.db
    .query("customDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  if (existing.length >= DOMAINS_PER_WORKSPACE) {
    throw new ConvexError({
      code: "LIMIT_REACHED",
      message: "This workspace already has a domain. Remove it to connect a different one.",
    });
  }

  // One sentence whichever workspace holds it, including this one: which
  // workspace has claimed a domain is not ours to tell a stranger.
  const taken = await ctx.db
    .query("customDomains")
    .withIndex("by_hostname", (q) => q.eq("hostname", normalized.hostname))
    .first();
  if (taken !== null) {
    throw new ConvexError({
      code: "HOSTNAME_TAKEN",
      message: "That domain is already connected to a Context workspace.",
    });
  }

  const now = Date.now();
  const domainId = await ctx.db.insert("customDomains", {
    workspaceId: args.workspaceId,
    hostname: normalized.hostname,
    apex: normalized.apex,
    status: "pending",
    verifyToken: mintOwnershipToken(),
    ownershipVerified: false,
    routingVerified: false,
    httpsReady: false,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
    checkingSince: now,
    checkCount: 0,
  });
  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "domain.connected",
    details: { hostname: normalized.hostname },
  });
  await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.provision, { domainId });
  return domainId;
}

export async function checkNowHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains"> },
): Promise<null> {
  const { row } = await domainForOwner(ctx, args.domainId);
  if (row.status !== "pending" && row.status !== "active") return null;
  const now = Date.now();
  // A press is a fresh run of checks; a second press seconds later is not a
  // second request to Cloudflare.
  if (row.checkedAt !== undefined && now - row.checkedAt < 5_000 && row.problem !== "TIMED_OUT") {
    return null;
  }
  await ctx.db.patch(row._id, {
    checkingSince: now,
    checkCount: 0,
    problem: row.problem === "TIMED_OUT" ? undefined : row.problem,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.provision, {
    domainId: row._id,
  });
  return null;
}

export async function setHomepageHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains">; slug: string | null },
): Promise<null> {
  const { row, userId } = await domainForOwner(ctx, args.domainId);
  if (args.slug === null) {
    await ctx.db.patch(row._id, { homeSlug: undefined, updatedAt: Date.now() });
  } else {
    const slug = shortLinkSlugFrom(args.slug.toLowerCase());
    const now = Date.now();
    const share =
      slug === null
        ? null
        : (
            await ctx.db
              .query("noteShares")
              .withIndex("by_workspace_slug", (q) => q.eq("workspaceId", row.workspaceId).eq("slug", slug))
              .collect()
          ).find(
            (candidate) =>
              candidate.status === "active" &&
              isLive(candidate, now) &&
              // A homepage is for whoever types the address. A members-only
              // link at the root would greet every visitor with a sign-in.
              candidate.recipientKind === "anyone",
          );
    if (slug === null || share === undefined) {
      throw new ConvexError({
        code: "LINK_NOT_FOUND",
        message: "Choose one of this workspace's short links that anyone can open.",
      });
    }
    await ctx.db.patch(row._id, { homeSlug: slug, updatedAt: now });
  }
  await recordAudit(ctx, {
    workspaceId: row.workspaceId,
    actorUserId: userId,
    action: "domain.homepage_set",
    details: { hostname: row.hostname, slug: args.slug },
  });
  return null;
}

export async function removeHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains"> },
): Promise<null> {
  const { row, userId } = await domainForOwner(ctx, args.domainId);
  if (row.status !== "removing") {
    await ctx.db.patch(row._id, { status: "removing", updatedAt: Date.now() });
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: userId,
      action: "domain.removed",
      details: { hostname: row.hostname },
    });
  }
  await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.deprovision, {
    domainId: row._id,
  });
  return null;
}

/** For the workspace-deletion cascade: every domain goes, provider side too. */
export async function releaseWorkspaceDomains(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
): Promise<void> {
  const rows = await ctx.db
    .query("customDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of rows) {
    if (row.providerId === undefined) {
      await ctx.db.delete(row._id);
      continue;
    }
    await ctx.db.patch(row._id, { status: "removing", updatedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.deprovision, {
      domainId: row._id,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Serving                                                                     */
/* -------------------------------------------------------------------------- */

export const resolvedHostValidator = v.union(
  v.null(),
  v.object({ handle: v.string(), homeSlug: v.union(v.string(), v.null()) }),
);

/**
 * Which workspace a request to this hostname is for, or `null`.
 *
 * Public and unauthenticated — the router and the page served at the domain
 * both ask — and it discloses only what the domain itself already publishes:
 * that it is a Context site, and the handle its short links resolve under.
 * `null` for every other case, uniformly: unknown, pending, suspended,
 * removing, not paying, malformed.
 */
export async function resolveHostHandler(
  ctx: QueryCtx,
  args: { hostname: string },
): Promise<Infer<typeof resolvedHostValidator>> {
  const normalized = normalizeHostname(args.hostname);
  if (!normalized.ok) return null;
  const row = await ctx.db
    .query("customDomains")
    .withIndex("by_hostname", (q) => q.eq("hostname", normalized.hostname))
    .first();
  if (row === null || row.status !== "active") return null;
  if (!(await workspacePaying(ctx, row.workspaceId))) return null;
  const workspace = await ctx.db.get(row.workspaceId);
  if (workspace === null) return null;
  return { handle: workspace.slug, homeSlug: row.homeSlug ?? null };
}

/* -------------------------------------------------------------------------- */
/* Internal: the provisioner's reads and writes                                */
/* -------------------------------------------------------------------------- */

export async function recordRegistrationHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains">; providerId: string },
): Promise<null> {
  const row = await ctx.db.get(args.domainId);
  if (row === null) return null;
  await ctx.db.patch(row._id, { providerId: args.providerId, updatedAt: Date.now() });
  return null;
}

export async function recordCheckHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains">; findings: CheckFindings },
): Promise<null> {
  const row = await ctx.db.get(args.domainId);
  if (row === null) return null;
  // Re-read at the moment of writing: an owner who removed the domain, or a
  // lapse the sweep already suspended, outranks whatever the check found.
  if (row.status !== "pending" && row.status !== "active") return null;
  if (!(await workspacePaying(ctx, row.workspaceId))) {
    await ctx.db.patch(row._id, { status: "suspended", updatedAt: Date.now() });
    return null;
  }
  const outcome = applyCheck(row, args.findings, Date.now());
  await ctx.db.patch(row._id, outcome.patch);
  if (outcome.patch.status === "active" && row.status !== "active") {
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      action: "domain.activated",
      details: { hostname: row.hostname },
    });
  }
  if (outcome.checkAgainIn !== null) {
    await ctx.scheduler.runAfter(outcome.checkAgainIn, internal.functions.customDomainsProvision.check, {
      domainId: row._id,
    });
  }
  return null;
}

export async function finishRemovalHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains"> },
): Promise<null> {
  const row = await ctx.db.get(args.domainId);
  if (row !== null && row.status === "removing") await ctx.db.delete(row._id);
  return null;
}

/** The periodic sweep. It chooses jobs; each job re-checks when it runs. */
export async function sweepHandler(ctx: MutationCtx): Promise<null> {
  const now = Date.now();
  const rows = await ctx.db.query("customDomains").collect();
  const paying = new Map<Id<"workspaces">, boolean>();
  for (const row of rows) {
    let isPaying = paying.get(row.workspaceId);
    if (isPaying === undefined) {
      isPaying = await workspacePaying(ctx, row.workspaceId);
      paying.set(row.workspaceId, isPaying);
    }
    const action = sweepActionFor(row, isPaying, now);
    switch (action.kind) {
      case "none":
        break;
      case "check":
        await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.check, {
          domainId: row._id,
        });
        break;
      case "suspend":
        await ctx.db.patch(row._id, { status: "suspended", updatedAt: now });
        break;
      case "resume":
        await ctx.db.patch(row._id, {
          status: "pending",
          checkingSince: now,
          checkCount: 0,
          problem: undefined,
          updatedAt: now,
        });
        await ctx.scheduler.runAfter(nextCheckDelay(0), internal.functions.customDomainsProvision.check, {
          domainId: row._id,
        });
        break;
      case "release":
      case "deprovision":
        if (row.status !== "removing") {
          await ctx.db.patch(row._id, { status: "removing", updatedAt: now });
        }
        await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.deprovision, {
          domainId: row._id,
        });
        break;
    }
  }
  return null;
}
