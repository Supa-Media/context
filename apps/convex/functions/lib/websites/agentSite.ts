/**
 * A website, seen and published by an agent through its MCP connection
 * (`/gateway/site`, the gateway's `write_note` `site` argument).
 *
 * _Decided by the owner, 2026-10-03_: owners and editors may publish through
 * MCP, the same people who may press Publish in the app. Two things make it
 * safe to hand an agent:
 *
 *  - **A draft has a name.** `draft` is a fingerprint of exactly what Publish
 *    would release: every file the publication scan read, by path and etag.
 *    An agent checks a draft, then publishes *that draft*; a save that landed
 *    in between is a conflict, never a release of words nobody looked at.
 *  - **Nothing here widens what a site may show.** Status and publish read
 *    the folder at the publication clearance, as the Publish button does, and
 *    a conflict still applies every restriction the scan found, as every scan
 *    does. Only Publish widens, and this is the same Publish.
 */

import { ConvexError, v } from "convex/values";
import { SITES_DOMAIN, sitesDomainAddress } from "@context/shared";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx, QueryCtx } from "../../../_generated/server";
import { APP_ORIGIN_ENV_VAR } from "../gatewayAuth";
import { PUBLICATION_CLEARANCE } from "./publication";
import { commitPublicationSnapshot } from "./releases";
import { scanWebsiteRoutes } from "./routes";

type Snapshot = Awaited<ReturnType<typeof scanWebsiteRoutes>>;

export interface PublishOutcome {
  published: boolean;
  problems: Array<{ path: string; message: string }>;
  /** Set when an expected draft was given and the folder no longer matches it. */
  conflict?: true;
  /** The draft that was released, or that the folder holds now. */
  draft?: string;
}

/** Every file the scan read, by path and etag, as 16 hex characters. */
export async function draftFingerprint(snapshot: Snapshot): Promise<string> {
  const lines = snapshot.indexed
    .map((route) => `${route.objectKey}\n${route.sourceEtag}`)
    .sort()
    .join("\n\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** A save that lands mid-publish takes the fence; the press tries again. */
const ATTEMPTS = 3;

/**
 * Publish as `actorUserId`, already cleared as an owner or editor by the
 * caller. The console's Publish button and an agent's publish are this one
 * function, so neither can drift into a laxer second path.
 */
export async function publishWebsiteAs(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    actorUserId: Id<"users">;
    actorClientId?: string;
    expectedDraft?: string;
  },
): Promise<PublishOutcome> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const generation = await ctx.runMutation(
      internal.functions.websites.beginRouteReconciliation,
      { workspaceId: args.workspaceId, enabledOnly: true },
    );
    if (generation === null) {
      throw new ConvexError({
        code: "WEBSITE_DISABLED",
        message: "Turn the website on to publish it.",
      });
    }
    const snapshot = await scanWebsiteRoutes(ctx, args.workspaceId, PUBLICATION_CLEARANCE, {
      publication: true,
    });
    const draft = await draftFingerprint(snapshot);
    if (args.expectedDraft !== undefined && args.expectedDraft !== draft) {
      // Not this draft: release nothing, but apply what every scan applies,
      // so a restriction the scan found is never held back by a conflict.
      await commitPublicationSnapshot(ctx, args.workspaceId, generation, snapshot, true, false);
      return { published: false, conflict: true, draft, problems: [] };
    }
    const problems = snapshot.statuses.flatMap((status) =>
      status.status === "problem"
        ? [
            {
              path: status.objectKey,
              message: status.problems[0]?.message ?? "This page cannot be published.",
            },
          ]
        : [],
    );
    const published = await commitPublicationSnapshot(
      ctx,
      args.workspaceId,
      generation,
      snapshot,
      true,
      true,
    );
    if (published) {
      await ctx.runMutation(internal.functions.audit.recordEvent, {
        workspaceId: args.workspaceId,
        actorUserId: args.actorUserId,
        ...(args.actorClientId === undefined ? {} : { actorClientId: args.actorClientId }),
        action: "website.published",
        details: { pages: snapshot.statuses.filter((s) => s.status === "live").length },
      });
      return { published: true, problems: [], draft };
    }
    if (problems.length > 0) return { published: false, problems, draft };
  }
  return { published: false, problems: [] };
}

/* ------------------------------- the agent's view ------------------------------- */

export interface SiteFacts {
  enabled: boolean;
  handle: string;
  publishedRevision: number | null;
  publishedAt: number | null;
  addresses: string[];
  /** What visitors are served now: path → etag, for the live published rows. */
  published: Array<{ objectKey: string; sourceEtag: string; routePath: string | null }>;
}

/** The database half of a status: the site's state, its addresses and its release. */
export async function siteFactsHandler(
  ctx: QueryCtx,
  args: { workspaceId: Id<"workspaces"> },
): Promise<SiteFacts | null> {
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) return null;
  const state = await ctx.db
    .query("websiteStates")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  const rows = await ctx.db
    .query("websiteRouteIndex")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const domains = await ctx.db
    .query("customDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .collect();
  const enabled = state?.state === "enabled";
  return {
    enabled,
    handle: workspace.slug,
    publishedRevision: state?.siteRevision ?? null,
    publishedAt: state?.publishedAt ?? null,
    addresses: enabled
      ? siteAddresses(
          workspace.slug,
          domains.filter((row) => row.status === "active" && row.wwwOf === undefined).map((row) => row.hostname),
        )
      : [],
    published: rows
      .filter((row) => row.status === "live")
      .map((row) => ({ objectKey: row.objectKey, sourceEtag: row.sourceEtag, routePath: row.routePath })),
  };
}

/**
 * Where visitors find the site: the app's `/@handle`, the sites domain where
 * this deployment is the one that serves it, and every custom domain that is
 * live. Built from the deployment's own origin, never guessed: one without
 * `APP_ORIGIN` lists only what it can name.
 */
export function siteAddresses(handle: string, customHostnames: string[]): string[] {
  const addresses: string[] = [];
  const origin = process.env[APP_ORIGIN_ENV_VAR];
  let base: URL | null = null;
  try {
    base = typeof origin === "string" && origin !== "" ? new URL(origin) : null;
  } catch {
    base = null;
  }
  if (base !== null && base.protocol === "https:") {
    addresses.push(`${base.origin}/@${handle}`);
    // `ctxlc.site` is served by production alone, the deployment at context.lc.
    if (base.hostname === "context.lc") addresses.push(`https://${sitesDomainAddress(handle)}`);
  }
  for (const hostname of customHostnames) {
    if (!hostname.endsWith(`.${SITES_DOMAIN}`)) addresses.push(`https://${hostname}`);
  }
  return addresses;
}

export interface SiteStatus {
  enabled: boolean;
  handle: string;
  draft: string | null;
  publishedRevision: number | null;
  publishedAt: number | null;
  addresses: string[];
  pages: Array<{
    path: string;
    address: string | null;
    status: string;
    audience: string;
    role: string | null;
    changed: boolean;
    problems: string[];
  }>;
  /** Pages visitors are served now that Publish would take down. */
  removed: Array<{ path: string; address: string | null }>;
}

/** What Publish would release now, against what visitors are served. */
export async function siteStatusFor(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
): Promise<SiteStatus | null> {
  const facts = await ctx.runQuery(internal.functions.websites.siteFacts, { workspaceId });
  if (facts === null) return null;
  const base = {
    enabled: facts.enabled,
    handle: facts.handle,
    publishedRevision: facts.publishedRevision,
    publishedAt: facts.publishedAt,
    addresses: facts.addresses,
  };
  if (!facts.enabled) return { ...base, draft: null, pages: [], removed: [] };

  const snapshot = await scanWebsiteRoutes(ctx, workspaceId, PUBLICATION_CLEARANCE, {
    publication: true,
  });
  const live = new Map(facts.published.map((row) => [row.objectKey, row]));
  const etags = new Map(snapshot.indexed.map((route) => [route.objectKey, route.sourceEtag]));
  return {
    ...base,
    draft: await draftFingerprint(snapshot),
    pages: snapshot.statuses.map((status) => ({
      path: status.objectKey,
      address: status.routePath,
      status: status.status,
      audience: status.audience,
      role: status.code ?? null,
      changed: status.status === "live" && live.get(status.objectKey)?.sourceEtag !== etags.get(status.objectKey),
      problems: status.problems.map((problem) => problem.message),
    })),
    removed: facts.published
      .filter((row) => !snapshot.statuses.some((status) => status.objectKey === row.objectKey && status.status === "live"))
      .map((row) => ({ path: row.objectKey, address: row.routePath })),
  };
}

/* ------------------------------- the gateway's door ------------------------------- */

export type GatewaySiteAnswer =
  | null
  | (SiteStatus & { action: "status" })
  | {
      action: "publish";
      published: boolean;
      conflict?: true;
      draft: string | null;
      revision: number | null;
      addresses: string[];
      problems: Array<{ path: string; message: string }>;
      message?: string;
    };

/**
 * `/gateway/site`, after the gateway secret: the user's token is spent here
 * for an owner or editor clearance, and every refusal before it is one `null`
 * — a member cannot tell "not an editor" from "no such workspace".
 */
export async function gatewaySiteHandler(
  ctx: ActionCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string; action: string; draft?: string },
): Promise<GatewaySiteAnswer> {
  if (args.action !== "status" && args.action !== "publish") return null;
  const cleared = await ctx.runQuery(internal.functions.controlPlane.editorClearanceForGateway, {
    hashedAccessToken: args.hashedAccessToken,
    expectedWorkspaceId: args.expectedWorkspaceId,
  });
  if (cleared === null) return null;

  if (args.action === "status") {
    const status = await siteStatusFor(ctx, cleared.workspaceId);
    return status === null ? null : { action: "status", ...status };
  }

  let outcome: PublishOutcome;
  try {
    outcome = await publishWebsiteAs(ctx, {
      workspaceId: cleared.workspaceId,
      actorUserId: cleared.actorUserId,
      actorClientId: cleared.clientId,
      ...(args.draft === undefined ? {} : { expectedDraft: args.draft }),
    });
  } catch (error) {
    if (error instanceof ConvexError && (error.data as { code?: string })?.code === "WEBSITE_DISABLED") {
      return {
        action: "publish",
        published: false,
        draft: null,
        revision: null,
        addresses: [],
        problems: [],
        message: "Turn the website on to publish it. Only the workspace's owner can, in the app.",
      };
    }
    throw error;
  }
  const facts = await ctx.runQuery(internal.functions.websites.siteFacts, { workspaceId: cleared.workspaceId });
  return {
    action: "publish",
    published: outcome.published,
    ...(outcome.conflict ? { conflict: true as const } : {}),
    draft: outcome.draft ?? null,
    revision: facts?.publishedRevision ?? null,
    addresses: facts?.addresses ?? [],
    problems: outcome.problems,
  };
}

/* --------------------------------- validators --------------------------------- */

const nullableNumber = v.union(v.number(), v.null());
const nullableString = v.union(v.string(), v.null());

export const siteFactsValidator = v.union(
  v.null(),
  v.object({
    enabled: v.boolean(),
    handle: v.string(),
    publishedRevision: nullableNumber,
    publishedAt: nullableNumber,
    addresses: v.array(v.string()),
    published: v.array(v.object({ objectKey: v.string(), sourceEtag: v.string(), routePath: nullableString })),
  }),
);

export const gatewaySiteValidator = v.union(
  v.null(),
  v.object({
    action: v.literal("status"),
    enabled: v.boolean(),
    handle: v.string(),
    draft: nullableString,
    publishedRevision: nullableNumber,
    publishedAt: nullableNumber,
    addresses: v.array(v.string()),
    pages: v.array(
      v.object({
        path: v.string(),
        address: nullableString,
        status: v.string(),
        audience: v.string(),
        role: nullableString,
        changed: v.boolean(),
        problems: v.array(v.string()),
      }),
    ),
    removed: v.array(v.object({ path: v.string(), address: nullableString })),
  }),
  v.object({
    action: v.literal("publish"),
    published: v.boolean(),
    conflict: v.optional(v.literal(true)),
    draft: nullableString,
    revision: nullableNumber,
    addresses: v.array(v.string()),
    problems: v.array(v.object({ path: v.string(), message: v.string() })),
    message: v.optional(v.string()),
  }),
);
