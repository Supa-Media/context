/**
 * Custom domains: a workspace's published links, served at an address its
 * owner brings.
 *
 * `docs.acme.com/` opens the homepage link the owner chose, and
 * `docs.acme.com/intake` opens the same share `context.lc/@acme/intake` does,
 * through the same authorization. Nothing is copied and nothing new is
 * published: a domain is a second address for links that already exist.
 *
 * Every export is a thin registration over `lib/customDomains/handlers.ts`,
 * where the rules and their reasons live. The provider calls are in
 * `customDomainsProvision.ts`, reached only by the schedule edges here.
 *
 * Owner-only to change, readable by any member: which address a workspace is
 * published at is not privileged, but choosing one is the owner's call, as
 * minting a link is.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import {
  checkNowHandler,
  connectHandler,
  finishRemovalHandler,
  recordCheckHandler,
  recordRegistrationHandler,
  removeHandler,
  resolvedHostValidator,
  resolveHostHandler,
  setHomepageHandler,
  settingsHandler,
  settingsValidator,
  sweepHandler,
} from "./lib/customDomains/handlers";

/** What the Domain settings section draws. */
export const settings = query({
  args: { workspaceId: v.id("workspaces") },
  returns: settingsValidator,
  handler: async (ctx, args) => await settingsHandler(ctx, args),
});

/** Claim a hostname for this workspace and start setting it up. */
export const connect = mutation({
  args: { workspaceId: v.id("workspaces"), hostname: v.string() },
  returns: v.id("customDomains"),
  handler: async (ctx, args) => await connectHandler(ctx, args),
});

/** Look again now, and restart a run of checks that stopped. */
export const checkNow = mutation({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => await checkNowHandler(ctx, args),
});

/** Choose which short link the domain's root opens, or none. */
export const setHomepage = mutation({
  args: { domainId: v.id("customDomains"), slug: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, args) => await setHomepageHandler(ctx, args),
});

/** Stop serving at this domain. Never touches a note or a link. */
export const remove = mutation({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => await removeHandler(ctx, args),
});

/** Which workspace a hostname serves, for the router and the site page. */
export const resolveHost = query({
  args: { hostname: v.string() },
  returns: resolvedHostValidator,
  handler: async (ctx, args) => await resolveHostHandler(ctx, args),
});

/* ---------------------------- internal plumbing --------------------------- */

export const rowForProvider = internalQuery({
  args: { domainId: v.id("customDomains") },
  handler: async (ctx, args) => await ctx.db.get(args.domainId),
});

export const recordRegistration = internalMutation({
  args: { domainId: v.id("customDomains"), providerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => await recordRegistrationHandler(ctx, args),
});

const readinessValidator = v.union(
  v.null(),
  v.object({
    routing: v.boolean(),
    https: v.boolean(),
    problem: v.union(v.null(), v.literal("ROUTING_BLOCKED"), v.literal("CERTIFICATE_FAILED")),
  }),
);

export const recordCheck = internalMutation({
  args: {
    domainId: v.id("customDomains"),
    findings: v.object({
      ownership: v.union(v.boolean(), v.null()),
      readiness: readinessValidator,
      providerProblem: v.optional(
        v.union(
          v.literal("NOT_CONFIGURED"),
          v.literal("PROVIDER_UNAVAILABLE"),
          v.literal("PROVIDER_REFUSED"),
          v.literal("ROUTING_BLOCKED"),
          v.literal("CERTIFICATE_FAILED"),
          v.literal("TIMED_OUT"),
        ),
      ),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => await recordCheckHandler(ctx, args),
});

export const finishRemoval = internalMutation({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => await finishRemovalHandler(ctx, args),
});

/** The cron's entry point. */
export const sweep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => await sweepHandler(ctx),
});
