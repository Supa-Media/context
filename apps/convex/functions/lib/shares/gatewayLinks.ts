/**
 * The gateway's half of links: the URL a link is at, and the one row every
 * gateway link route answers with.
 *
 * Split out of `functions/shares.ts`, which keeps every registered function —
 * including the gateway routes that spend an access token on owner clearance
 * before reaching anything here — and wires these handlers to them; this
 * module registers none.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { normalizePath } from "../fileOps";
import { shortLinkSlugRejection } from "../shareSlug";
import { DEFAULT_COLLECT_CAP } from "../collectLimits";
import { APP_ORIGIN_ENV_VAR } from "../gatewayAuth";
import { SHARE_ROUTE, shareSegment } from "@context/shared";
import { isLive } from "./standing";

/**
 * The URL a link is at, built here rather than by whoever asked.
 *
 * **An agent that assembled its own would be guessing**, which is the whole
 * complaint this feature answers: `/s/` versus `/share/`, the readable slug or
 * not, the origin of a self-hosted deployment. The console already builds it
 * from `@context/shared`; so does this, from the same function.
 *
 * `null` when `APP_ORIGIN` is unset or is not https. A self-hosted deployment
 * that has not told us where it is served from cannot be handed a URL, and
 * inventing one would send somebody's colleague to a domain we picked. The
 * caller reports the path instead, and says why.
 */
export function shareUrlsFor(
  row: { token: string; previewTitle?: string; titleInPreview: boolean; slug?: string },
  handle: string | null,
): { url: string | null; shortUrl: string | null; path: string } {
  // The title only decorates the URL where the owner left it on the card: the
  // URL travels further than the card does, so a setting that hides the name
  // has to hide it here too. `shareUrlFor` in the console is the same rule.
  const title = row.titleInPreview ? (row.previewTitle ?? null) : null;
  const path = `${SHARE_ROUTE}/${shareSegment(row.token, title)}`;
  const shortPath =
    row.slug === undefined || handle === null ? null : `/@${handle}/${row.slug}`;

  const origin = process.env[APP_ORIGIN_ENV_VAR];
  if (typeof origin !== "string" || origin.length === 0) {
    return { url: null, shortUrl: null, path };
  }
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return { url: null, shortUrl: null, path };
  }
  if (base.protocol !== "https:") return { url: null, shortUrl: null, path };
  const root = base.origin;
  return {
    url: `${root}${path}`,
    shortUrl: shortPath === null ? null : `${root}${shortPath}`,
    path,
  };
}

/** One row, as every gateway link route reports it. */
export interface GatewayLink {
  shareId: Id<"noteShares">;
  url: string | null;
  shortUrl: string | null;
  path: string;
  audience: "name" | "email" | "members" | "anyone";
  entryPath: string;
  slug: string | null;
  /** Whether this link takes answers to a form, rather than only showing it. */
  collecting: boolean;
  /** Answers taken so far, and the ceiling. Both `null` on a read link. */
  collected: number | null;
  collectCap: number | null;
  createdAt: number;
}

/** What every gateway link route answers with, for one row. */
export const gatewayLinkSummary = v.object({
  shareId: v.id("noteShares"),
  /**
   * The whole URL, or `null` on a deployment that has not set `APP_ORIGIN`.
   *
   * The *URL*, never the token: the point of this route is that nothing
   * downstream assembles one. `path` is what a self-hosted deployment gets
   * instead, so the answer is still usable by somebody who knows their own
   * origin — and the agent is told to say so rather than guess.
   */
  url: v.union(v.string(), v.null()),
  shortUrl: v.union(v.string(), v.null()),
  path: v.string(),
  audience: v.union(
    v.literal("name"),
    v.literal("email"),
    v.literal("members"),
    v.literal("anyone"),
  ),
  entryPath: v.string(),
  slug: v.union(v.string(), v.null()),
  /**
   * Whether this link takes answers, rather than only showing what it points
   * at.
   *
   * Reported on every link route so that an agent listing a context's links
   * can tell the two apart without a second call — and so that "make the
   * intake form live" and "did it work" are the same shape of answer.
   */
  collecting: v.boolean(),
  /**
   * How many answers have come through, and the most that will.
   *
   * Reported so that "how many people have filled it in" and "is it about to
   * stop" are one call rather than a trip to the console. `null` on a link
   * that collects nothing, because zero of zero reads as a broken form.
   */
  collected: v.union(v.number(), v.null()),
  collectCap: v.union(v.number(), v.null()),
  createdAt: v.number(),
});

export const gatewayNameAndDescribeArgs = {
  workspaceId: v.id("workspaces"),
  actorUserId: v.id("users"),
  path: v.string(),
  audience: v.union(v.literal("members"), v.literal("anyone")),
  short: v.optional(v.string()),
};

export const gatewayNameAndDescribeReturns = v.union(
  v.null(),
  v.object({ link: gatewayLinkSummary, shortRefused: v.union(v.string(), v.null()) }),
);

// Annotated rather than inferred, like `readSharedNote`: a function that
// calls another in the same deployment is the inference cycle that degrades
// the whole generated `api` to `any`, and the symptom is implicit-any errors
// in unrelated test files.
/**
 * Claim the short name if one was asked for, then describe the row. INTERNAL.
 *
 * One mutation for both because they are one transaction's worth of work and
 * because the description has to be of the row *after* the name landed — a
 * two-call version would return a `shortUrl` of `null` for a name it had just
 * claimed, which is the kind of wrong that reads as a bug in the name rather
 * than in the reporting.
 */
export async function gatewayNameAndDescribeHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof gatewayNameAndDescribeArgs>,
): Promise<{ link: GatewayLink; shortRefused: string | null } | null> {
  const path = normalizePath(args.path);
  if (path === null) return null;

  const row = await ctx.db
    .query("noteShares")
    .withIndex("by_workspace_entry_recipient", (q) =>
      q
        .eq("workspaceId", args.workspaceId)
        .eq("entryPath", path)
        .eq("recipientKind", args.audience)
        .eq("recipient", ""),
    )
    .unique();
  if (row === null || row.status !== "active") return null;

  let shortRefused: string | null = null;
  if (args.short !== undefined) {
    const slug = args.short.trim().toLowerCase();
    const rejection = shortLinkSlugRejection(slug);
    if (rejection !== null) {
      shortRefused = rejection;
    } else {
      const now = Date.now();
      const holders = await ctx.db
        .query("noteShares")
        .withIndex("by_workspace_slug", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("slug", slug),
        )
        .collect();
      const taken = holders.find(
        (other) => other._id !== row._id && other.status === "active" && isLive(other, now),
      );
      if (taken !== undefined) {
        shortRefused = "That name already points at another link in this context.";
      } else {
        await ctx.db.patch(row._id, { slug });
        row.slug = slug;
        await recordAudit(ctx, {
          workspaceId: args.workspaceId,
          actorUserId: args.actorUserId,
          action: "share.slug.claimed",
          paths: [path],
          details: { slug, audience: row.recipientKind, via: "gateway" },
        });
      }
    }
  }

  const handle = await workspaceHandle(ctx, args.workspaceId);
  const urls = shareUrlsFor(row, handle);
  return {
    link: {
      shareId: row._id,
      url: urls.url,
      shortUrl: urls.shortUrl,
      path: urls.path,
      audience: row.recipientKind,
      entryPath: row.entryPath,
      slug: row.slug ?? null,
      collecting: row.mode === "collect",
      collected: row.mode === "collect" ? (row.collectCount ?? 0) : null,
      collectCap: row.mode === "collect" ? (row.collectCap ?? DEFAULT_COLLECT_CAP) : null,
      createdAt: row.createdAt,
    },
    shortRefused,
  };
}

/** The context's own handle, for the short half of a URL. */
export async function workspaceHandle(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<string | null> {
  const workspace = await ctx.db.get(workspaceId);
  return workspace?.slug ?? null;
}
