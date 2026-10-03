/**
 * `www.` beside a root domain.
 *
 * People type `www.acme.com` as often as `acme.com`, so connecting a root
 * domain also registers its `www.` companion: a second row, with its own
 * Cloudflare registration and its own CNAME, that never serves a page. Every
 * request to it is sent to the root with a permanent redirect, so a site has
 * one address and search engines and links agree on it.
 *
 * The companion is proved by its root, never on its own: it carries the
 * root's claim token, and it counts as owned only once the root's
 * `_context.<root>` record has been seen for that claim. Control of a zone's
 * apex record is control of the zone, so no second TXT record is asked for —
 * and a `www.` name somebody else had already claimed is left to them.
 *
 * Only a root domain gets one, and only its owner's: a subdomain, or a name
 * that already starts with `www.`, has nothing to pair with.
 */

import { internal } from "../../../_generated/api";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { normalizeHostname } from "./hostname";

type Row = Doc<"customDomains">;

/** The companion name a root domain is paired with, or null for none. */
export function wwwHostnameFor(row: Pick<Row, "hostname" | "apex" | "wwwOf">): string | null {
  if (!row.apex || row.wwwOf !== undefined || row.hostname.startsWith("www.")) return null;
  const normalized = normalizeHostname(`www.${row.hostname}`);
  return normalized.ok ? normalized.hostname : null;
}

/** The root's companion row, if it has one. */
export async function wwwCompanionOf(ctx: QueryCtx, root: Row): Promise<Row | null> {
  const hostname = wwwHostnameFor(root);
  if (hostname === null) return null;
  const row = await ctx.db
    .query("customDomains")
    .withIndex("by_hostname", (q) => q.eq("hostname", hostname))
    .first();
  return row !== null && row.wwwOf === root._id ? row : null;
}

/**
 * Register the root's companion if it has none and the name is free.
 * Idempotent: the sweep calls it for every root domain, which is how a domain
 * connected before companions existed gets its `www.`.
 */
export async function ensureWwwCompanion(ctx: MutationCtx, root: Row): Promise<Id<"customDomains"> | null> {
  if (root.status !== "pending" && root.status !== "active") return null;
  const hostname = wwwHostnameFor(root);
  if (hostname === null) return null;
  const holder = await ctx.db
    .query("customDomains")
    .withIndex("by_hostname", (q) => q.eq("hostname", hostname))
    .first();
  // Somebody's claim, ours or another workspace's, is never taken over.
  if (holder !== null) return holder.wwwOf === root._id ? holder._id : null;
  const now = Date.now();
  const domainId = await ctx.db.insert("customDomains", {
    workspaceId: root.workspaceId,
    hostname,
    apex: false,
    status: "pending",
    verifyToken: root.verifyToken,
    ownershipVerified: root.ownershipVerified,
    routingVerified: false,
    httpsReady: false,
    createdBy: root.createdBy,
    createdAt: now,
    updatedAt: now,
    checkingSince: now,
    checkCount: 0,
    wwwOf: root._id,
  });
  await ctx.scheduler.runAfter(0, internal.functions.customDomainsProvision.provision, { domainId });
  return domainId;
}

/**
 * Whether a companion's root has proved this claim. Read by the checker in
 * place of a DNS lookup of the companion's own name.
 */
export function rootProves(companion: Pick<Row, "verifyToken">, root: Row | null): boolean {
  return root !== null && root.ownershipVerified && root.verifyToken === companion.verifyToken;
}

/**
 * Where a request to a companion goes: its root, while the root itself is
 * live. Anything else is the same nothing an unknown host gets.
 */
export async function wwwRedirectFor(ctx: QueryCtx, companion: Row): Promise<string | null> {
  if (companion.wwwOf === undefined || companion.status !== "active") return null;
  const root = await ctx.db.get(companion.wwwOf);
  if (root === null || root.status !== "active" || root.workspaceId !== companion.workspaceId) return null;
  return companion.hostname === `www.${root.hostname}` ? root.hostname : null;
}
