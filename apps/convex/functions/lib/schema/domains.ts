import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Customer domains: the addresses a workspace's published links are served at.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts`. Metadata only — a hostname, whose it is, and how far
 * its setup has got. What the domain serves is the workspace's existing share
 * rows, read through the same authorization as `context.lc/@name/<short>`.
 */

/** Where a domain is in its life. See `lib/customDomains/lifecycle.ts`. */
export const customDomainStatus = v.union(
  // Registered or being registered; waiting on the customer's DNS or on
  // Cloudflare's certificate. Never served.
  v.literal("pending"),
  // Every check passed. The only state the router serves.
  v.literal("active"),
  // The workspace stopped paying. Kept, registration and all, so paying again
  // resumes rather than starts over; not served meanwhile.
  v.literal("suspended"),
  // The owner removed it; the provider registration is being deleted. The row
  // is deleted when that finishes, which is what frees the hostname.
  v.literal("removing"),
);

/**
 * Why a pending domain is not live, as a code the screen maps to a sentence.
 * Our vocabulary, never the provider's text.
 */
export const customDomainProblem = v.union(
  v.literal("NOT_CONFIGURED"),
  v.literal("PROVIDER_UNAVAILABLE"),
  v.literal("PROVIDER_REFUSED"),
  v.literal("ROUTING_BLOCKED"),
  v.literal("CERTIFICATE_FAILED"),
  v.literal("TIMED_OUT"),
);

export const domainTables = {
  customDomains: defineTable({
    workspaceId: v.id("workspaces"),
    /** Lowercase ASCII, punycode for IDNs — `normalizeHostname`'s output only. */
    hostname: v.string(),
    /** Two labels, so the DNS instructions lead with the apex caveat. */
    apex: v.boolean(),
    status: customDomainStatus,
    /**
     * The value of this claim's ownership TXT record. Not a secret — the
     * customer publishes it in DNS — but minted per claim, so a record left
     * behind by an earlier claim cannot verify a new one.
     */
    verifyToken: v.string(),
    /** Cloudflare's id for the registration, once there is one. */
    providerId: v.optional(v.string()),
    ownershipVerified: v.boolean(),
    routingVerified: v.boolean(),
    httpsReady: v.boolean(),
    problem: v.optional(customDomainProblem),
    /** The short link the domain's root opens. Absent: an empty homepage. */
    homeSlug: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    /** When the checker last asked, and how many times since the last reset. */
    checkedAt: v.optional(v.number()),
    /** When the current run of checks began: a claim, a retry, a resume. */
    checkingSince: v.number(),
    checkCount: v.number(),
    activatedAt: v.optional(v.number()),
    /**
     * Domain Connect: the customer's DNS provider has our template, and this
     * signed link applies both records there. Absent: add them by hand.
     */
    oneClick: v.optional(v.object({ provider: v.string(), url: v.string() })),
    /** Cloudflare's TXT for a root domain, as its registration last gave it. */
    hostnameTxt: v.optional(v.object({ name: v.string(), value: v.string() })),
  })
    .index("by_hostname", ["hostname"])
    .index("by_workspace", ["workspaceId"])
    .index("by_status", ["status"]),
};
