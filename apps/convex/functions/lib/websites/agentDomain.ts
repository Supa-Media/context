/**
 * A workspace's custom domain, seen and connected by an agent through its MCP
 * connection (`/gateway/site` `domain`, the gateway's `write_note`
 * `site: { action: "domain", hostname? }`).
 *
 * _Asked for by the owner, 2026-10-13_: Tex, the texting assistant, should
 * set up a person's website down to its domain, connecting one they already
 * have and walking them through its DNS. Connecting a domain is the settings
 * screen's Connect, so it is the same function (`connectDomainAs`), owner-only
 * and Premium-only exactly as the button is, and the answer is the same view
 * the screen draws (`domainViewFor`), records included only for the owner.
 *
 * A domain is a second address for what the site already publishes, so
 * nothing here widens what anybody can see: no page is released and no
 * privacy rule is read. Buying a domain is not here at all; it spends the
 * person's money at a registrar, in their own account, with their own yes.
 */

import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { customDomainsDeployment } from "../customDomains/config";
import {
  checkDomainNow,
  connectDomainAs,
  domainViewFor,
  domainViewValidator,
  workspacePaying,
} from "../customDomains/handlers";
import { normalizeHostname } from "../customDomains/hostname";
import { getMembership, roleAtLeast } from "../workspaceAuth";

export const agentDomainValidator = v.object({
  /** This deployment serves customer domains at all. */
  available: v.boolean(),
  paying: v.boolean(),
  /** The caller is the workspace's owner, the one person who may connect a domain. */
  owner: v.boolean(),
  domain: v.union(domainViewValidator, v.null()),
  /** Why a connect did nothing, in words a person can be told. */
  message: v.optional(v.string()),
});

export type AgentDomain = Infer<typeof agentDomainValidator>;

/**
 * The domain answer, after the caller's editor clearance. With `hostname`,
 * an owner connects it, or, when it is the one already connected, checks it
 * again; without, a domain still on its way is checked again, the way the
 * screen's "Check again" is, so an agent asking "is it live yet?" gets a
 * fresh look rather than the last one. A check is throttled where the button's is.
 */
export async function agentDomainHandler(
  ctx: MutationCtx,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; hostname?: string },
): Promise<AgentDomain> {
  const membership = await getMembership(ctx, args.workspaceId, args.userId);
  const owner = membership !== null && roleAtLeast(membership.role, "owner");
  const available = customDomainsDeployment() !== null;
  const paying = await workspacePaying(ctx, args.workspaceId);
  let message: string | undefined;

  const current = await domainViewFor(ctx, args.workspaceId, owner);
  if (args.hostname !== undefined) {
    const normalized = normalizeHostname(args.hostname);
    const asked = normalized.ok ? normalized.hostname : null;
    if (!owner) {
      message = "Only the workspace's owner can connect a domain.";
    } else if (current !== null && current.hostname === asked) {
      await recheck(ctx, current.id);
    } else if (current !== null) {
      message = `This workspace already has ${current.hostname}. Its owner removes it in Settings › Website before connecting a different one.`;
    } else {
      try {
        await connectDomainAs(ctx, args.workspaceId, args.userId, args.hostname);
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error;
        const data = error.data as { message?: unknown } | string;
        message =
          typeof data === "object" && data !== null && typeof data.message === "string"
            ? data.message
            : "That domain couldn't be connected.";
      }
    }
  } else if (owner && current !== null && current.status === "pending") {
    await recheck(ctx, current.id);
  } else if (current === null && !paying) {
    // Said here, beside the plan, so the gateway never reads billing state
    // (scripts/check-exit-is-ungated.mjs).
    message = "Custom domains are part of Premium.";
  }

  return {
    available,
    paying,
    owner,
    domain: await domainViewFor(ctx, args.workspaceId, owner),
    ...(message === undefined ? {} : { message }),
  };
}

async function recheck(ctx: MutationCtx, domainId: Id<"customDomains">): Promise<void> {
  const row = await ctx.db.get(domainId);
  if (row !== null) await checkDomainNow(ctx, row);
}
