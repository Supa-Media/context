/**
 * The database half of custom domains: what the settings screen reads, what an
 * owner can do, and how a check's findings land on the row.
 *
 * Registered in `functions/customDomains.ts`. Everything that talks to DNS or
 * to Cloudflare is an internal action in `functions/customDomainsProvision.ts`,
 * reached only by a schedule edge from here — scheduling is not calling, so no
 * public function here is a path to the provider credential.
 */

import { rootRecordType, sitesSubdomainHandle } from "@context/shared";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { dnsHostValidator, domainHintValidator } from "../schema/domains";
import { planFor, requireUserId, statusOf } from "../billing/plan";
import { planIsPaying } from "../premium";
import { shortLinkSlugFrom } from "../shareSlug";
import { isLive } from "../shares/standing";
import { roleAtLeast, requireWorkspaceAccess, requireWorkspaceRole } from "../workspaceAuth";
import { customDomainsDeployment } from "./config";
import { mintOwnershipToken, ownershipRecordName, ownershipRecordValue } from "./dns";
import { sitesDomainBinding } from "./sitesDomain";
import { describeHostnameRejection, normalizeHostname, relativeRecordName } from "./hostname";
import {
  applyCheck,
  DOMAINS_PER_WORKSPACE,
  nextCheckDelay,
  stageOf,
  sweepActionFor,
  type CheckFindings,
} from "./lifecycle";
import { ensureWwwCompanion, wwwCompanionOf, wwwHostnameFor, wwwRedirectFor } from "./www";

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
  purpose: v.union(v.literal("ownership"), v.literal("routing"), v.literal("hostname"), v.literal("www")),
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
  /** When this round of checks began: connect, "Check again", or a live domain losing its records. */
  checkingSince: v.number(),
  /** Owner only: the records to add. Empty for anybody else. */
  records: v.array(dnsRecordValidator),
  /** Owner only, while records are missing: set them up at the DNS provider in one click. */
  oneClick: v.union(v.object({ provider: v.string(), url: v.string() }), v.null()),
  /**
   * A root domain's `www.`, which sends visitors to the root once it is live.
   * It has a registration and a certificate of its own, so it can still be
   * on its way, or stuck, after the root is live; its own stage and problem
   * say which.
   */
  www: v.union(
    v.object({
      hostname: v.string(),
      live: v.boolean(),
      stage: v.union(v.literal("ownership"), v.literal("routing"), v.literal("https"), v.literal("live")),
      problem: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  /** Where the domain's zone starts, when public DNS said. */
  zone: v.union(v.string(), v.null()),
  /** The company that runs the domain's DNS, from its name servers. */
  dnsHost: v.union(dnsHostValidator, v.null()),
  /** Owner only: what is in the way, named on the step it belongs to. */
  hints: v.array(domainHintValidator),
  /**
   * Owner only, for `www.<root>` connected on its own: the root has to be
   * forwarded to it at the DNS company, and whether it is yet.
   */
  forwarding: v.union(v.object({ root: v.string(), forwards: v.union(v.boolean(), v.null()) }), v.null()),
  /** Owner only: the setup steps were emailed to this address. */
  stepsSent: v.union(v.object({ to: v.string(), at: v.number() }), v.null()),
});

export const settingsValidator = v.object({
  /** This deployment serves customer domains at all. */
  available: v.boolean(),
  paying: v.boolean(),
  canManage: v.boolean(),
  domain: v.union(domainViewValidator, v.null()),
});

export type DomainSettings = Infer<typeof settingsValidator>;

function recordsFor(row: Row, www: Row | null, target: string): Infer<typeof dnsRecordValidator>[] {
  const ownershipName = ownershipRecordName(row.hostname);
  // Where the zone really starts, once public DNS has said (`survey.ts`).
  const zone = row.survey?.zone ?? null;
  const relative = (name: string) => relativeRecordName(name, row.hostname, zone);
  return [
    {
      purpose: "routing",
      type: row.apex ? rootRecordType(row.survey?.dnsHost?.key ?? null) : "CNAME",
      name: row.hostname,
      host: relative(row.hostname),
      value: target,
      done: row.routingVerified,
    },
    // A root domain answers with addresses rather than a CNAME, so Cloudflare
    // wants its own TXT before it serves it. Found when the hostname goes
    // active, the same moment as the ALIAS: neither can be seen apart.
    ...(row.apex && row.hostnameTxt !== undefined
      ? [
          {
            purpose: "hostname" as const,
            type: "TXT",
            name: row.hostnameTxt.name,
            host: relative(row.hostnameTxt.name),
            value: row.hostnameTxt.value,
            done: row.routingVerified,
          },
        ]
      : []),
    {
      purpose: "ownership",
      type: "TXT",
      name: ownershipName,
      host: relative(ownershipName),
      value: ownershipRecordValue(row.verifyToken),
      done: row.ownershipVerified,
    },
    // Proved by the root's TXT above, so it needs only somewhere to point.
    ...(www === null
      ? []
      : [
          {
            purpose: "www" as const,
            type: "CNAME",
            name: www.hostname,
            host: relative(www.hostname),
            value: target,
            done: www.routingVerified,
          },
        ]),
  ];
}

/** The workspace's own domain: never its `www.` companion. */
async function rootDomainOf(ctx: QueryCtx, workspaceId: Id<"workspaces">): Promise<Row | null> {
  const rows = await ctx.db
    .query("customDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  return rows.find((row) => row.wwwOf === undefined) ?? null;
}

export async function settingsHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<DomainSettings> {
  const userId = await requireUserId(ctx);
  const { membership } = await requireWorkspaceAccess(ctx, args.workspaceId, userId);
  const canManage = roleAtLeast(membership.role, "owner");
  return {
    available: customDomainsDeployment() !== null,
    paying: await workspacePaying(ctx, args.workspaceId),
    canManage,
    domain: await domainViewFor(ctx, args.workspaceId, canManage),
  };
}

/**
 * The workspace's domain as the settings screen draws it, with the records to
 * add only when `canManage`. Shared with an owner's agent
 * (`agentDomain.ts`), so the two can never describe one domain differently.
 */
export async function domainViewFor(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
  canManage: boolean,
): Promise<DomainSettings["domain"]> {
  const deployment = customDomainsDeployment();
  const row = await rootDomainOf(ctx, workspaceId);
  if (row === null) return null;
  const www = await wwwCompanionOf(ctx, row);
  return {
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
    checkingSince: row.checkingSince,
    records: canManage && deployment !== null ? recordsFor(row, www, deployment.target) : [],
    oneClick:
      canManage && row.status === "pending" && !(row.ownershipVerified && row.routingVerified)
        ? (row.oneClick ?? null)
        : null,
    www:
      www === null
        ? null
        : {
            hostname: www.hostname,
            live: www.status === "active",
            stage: stageOf(www),
            problem: www.problem ?? null,
          },
    zone: row.survey?.zone ?? null,
    dnsHost: row.survey?.dnsHost ?? null,
    hints: canManage && row.status === "pending" ? (row.survey?.hints ?? []) : [],
    forwarding:
      canManage && row.hostname.startsWith("www.") && (row.status === "pending" || row.status === "active")
        ? { root: row.hostname.slice(4), forwards: row.survey?.forwards ?? null }
        : null,
    stepsSent: canManage ? (row.stepsSent ?? null) : null,
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
  return await connectDomainAs(ctx, args.workspaceId, userId, args.hostname);
}

/**
 * Claim `hostname` for the workspace as `userId`, who must be its owner: the
 * settings screen's Connect and an owner's agent are this one function.
 */
export async function connectDomainAs(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  userId: Id<"users">,
  hostname: string,
): Promise<Id<"customDomains">> {
  const args = { workspaceId, hostname };
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
  if (existing.filter((row) => row.wwwOf === undefined).length >= DOMAINS_PER_WORKSPACE) {
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
  await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.detectProvider, { domainId });
  const root = await ctx.db.get(domainId);
  if (root !== null) await ensureWwwCompanion(ctx, root);
  return domainId;
}

export async function checkNowHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains"> },
): Promise<null> {
  const { row } = await domainForOwner(ctx, args.domainId);
  return await checkDomainNow(ctx, row);
}

/** "Check again", on a row the caller has already cleared as its owner's. */
export async function checkDomainNow(ctx: MutationCtx, row: Row): Promise<null> {
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
  const www = await wwwCompanionOf(ctx, row);
  if (www !== null && (www.status === "pending" || www.status === "active")) {
    await ctx.db.patch(www._id, { checkingSince: now, checkCount: 0, problem: undefined, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.provision, { domainId: www._id });
  }
  // A provider can take up our template after the domain was connected, so a
  // domain without a button looks again whenever its owner asks for a check.
  if (row.status === "pending" && row.oneClick === undefined) {
    await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.detectProvider, {
      domainId: row._id,
    });
  }
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
  const { row: named, userId } = await domainForOwner(ctx, args.domainId);
  // A `www.` goes with its root, and only with it: removed alone, the sweep
  // would only register it again.
  const root = named.wwwOf === undefined ? named : await ctx.db.get(named.wwwOf);
  const row = root ?? named;
  if (row.status !== "removing") {
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      actorUserId: userId,
      action: "domain.removed",
      details: { hostname: row.hostname },
    });
  }
  await startRemoval(ctx, row);
  return null;
}

/** Mark a domain and its `www.` removing, and delete them at the provider. */
async function startRemoval(ctx: MutationCtx, row: Row): Promise<void> {
  const www = await wwwCompanionOf(ctx, row);
  for (const target of www === null ? [row] : [row, www]) {
    if (target.status !== "removing") {
      await ctx.db.patch(target._id, { status: "removing", updatedAt: Date.now() });
    }
    await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.deprovision, {
      domainId: target._id,
    });
  }
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
  /** A root domain's `www.`: every request is sent to the root. */
  v.object({ redirect: v.string() }),
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
  const handle = sitesSubdomainHandle(args.hostname);
  if (handle !== null) return await sitesDomainBinding(ctx, handle);
  const normalized = normalizeHostname(args.hostname);
  if (!normalized.ok) return null;
  const row = await ctx.db
    .query("customDomains")
    .withIndex("by_hostname", (q) => q.eq("hostname", normalized.hostname))
    .first();
  if (row === null || row.status !== "active") return null;
  if (!(await workspacePaying(ctx, row.workspaceId))) return null;
  if (row.wwwOf !== undefined) {
    const redirect = await wwwRedirectFor(ctx, row);
    return redirect === null ? null : { redirect };
  }
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

/** Where Domain Connect detection landed: a link to offer, or nothing. */
export async function recordOneClickHandler(
  ctx: MutationCtx,
  args: { domainId: Id<"customDomains">; oneClick: { provider: string; url: string } | null },
): Promise<null> {
  const row = await ctx.db.get(args.domainId);
  if (row === null || row.status === "removing") return null;
  await ctx.db.patch(row._id, { oneClick: args.oneClick ?? undefined, updatedAt: Date.now() });
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
  // The root's TXT is what proves its `www.`, so the moment it is seen the
  // companion looks again rather than waiting out its own backoff.
  if (outcome.patch.ownershipVerified === true && !row.ownershipVerified) {
    const www = await wwwCompanionOf(ctx, row);
    if (www !== null && www.status === "pending") {
      await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.check, { domainId: www._id });
    }
  }
  if (outcome.patch.status === "active" && row.status !== "active") {
    await recordAudit(ctx, {
      workspaceId: row.workspaceId,
      action: "domain.activated",
      details: { hostname: row.hostname },
    });
    // Once per claim, for the domain itself: its `www.` is the same news.
    if (row.wwwOf === undefined && row.liveMailSentAt === undefined) {
      await ctx.db.patch(row._id, { liveMailSentAt: Date.now() });
      await ctx.scheduler.runAfter(0, internal.functions.customDomainsMail.sendLive, { domainId: row._id });
    }
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
    // A root domain connected before `www.` companions existed gets one here.
    if (action.kind !== "release" && action.kind !== "deprovision" && isPaying && wwwHostnameFor(row) !== null) {
      await ensureWwwCompanion(ctx, row);
    }
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
        await startRemoval(ctx, row);
        break;
    }
  }
  return null;
}
