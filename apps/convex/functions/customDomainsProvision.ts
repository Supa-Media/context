/**
 * Registering, checking and removing customer domains at the provider.
 *
 * Every entry point is an `internalAction` reached only by a schedule edge
 * from `functions/customDomains.ts` or the sweep — scheduling is not calling,
 * so the public mutations that start them are not paths to the credential
 * these open (`docs/decisions/storage-and-credentials.md`).
 *
 * ## The credential
 *
 * `CUSTOM_DOMAINS_API_TOKEN` from `appSecrets`: a token of ours, zone-scoped
 * to the one zone customer hostnames are registered in. Absent is an ordinary
 * state — the check records `NOT_CONFIGURED` and waits for "Check again".
 *
 * ## Failure is recorded, never thrown away
 *
 * Each run ends in `recordCheck`, whatever happened, so a row never sits
 * "checking" with nobody coming back to it. What lands on the row is our own
 * problem code; Cloudflare's text goes to the log beside the domain id.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { CUSTOM_DOMAINS_TOKEN_SECRET, customDomainsDeployment } from "./lib/customDomains/config";
import { ownershipPublished } from "./lib/customDomains/dns";
import {
  discoverProvider,
  DOMAIN_CONNECT_SIGNING_KEY_SECRET,
  DOMAIN_CONNECT_TARGET,
  hostWithinZone,
  signedApplyUrl,
} from "./lib/customDomains/domainConnect";
import type { CheckFindings, DomainProblem } from "./lib/customDomains/lifecycle";
import {
  deleteHostname,
  findHostname,
  ProviderError,
  readHostname,
  readinessOf,
  registerHostname,
  type CustomHostname,
  type ProviderConfig,
} from "./lib/customDomains/provider";

async function providerConfig(ctx: ActionCtx): Promise<ProviderConfig | null> {
  const deployment = customDomainsDeployment();
  if (deployment === null) return null;
  const apiToken: string | null = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
    name: CUSTOM_DOMAINS_TOKEN_SECRET,
  });
  if (apiToken === null || apiToken.length === 0) return null;
  return { apiToken, zoneId: deployment.zoneId };
}

function problemFor(error: unknown): DomainProblem {
  if (error instanceof ProviderError) {
    return error.code === "UNAVAILABLE" ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REFUSED";
  }
  return "PROVIDER_UNAVAILABLE";
}

function logFailure(stage: string, row: Doc<"customDomains">, error: unknown): void {
  console.error(
    JSON.stringify({
      event: "custom_domain.provider_failure",
      stage,
      domainId: row._id,
      workspaceId: row.workspaceId,
      code: error instanceof ProviderError ? error.code : "UNKNOWN",
      detail: error instanceof ProviderError ? error.detail : String((error as Error)?.message ?? ""),
    }),
  );
}

/**
 * Make sure the provider holds a registration for this row, and return it.
 *
 * Idempotent across crashes: a create that succeeded but whose id never
 * reached the row comes back as a duplicate, and is adopted. Adopting is safe
 * because the `by_hostname` uniqueness in `connect` means no other row can be
 * claiming this name — a registration for it in our zone with no row is our
 * own leftover, never another customer's live domain.
 */
async function ensureRegistration(
  ctx: ActionCtx,
  config: ProviderConfig,
  row: Doc<"customDomains">,
): Promise<CustomHostname | null> {
  if (row.providerId !== undefined) {
    const existing = await readHostname(config, row.providerId);
    if (existing !== null) return existing;
  }
  let registration: CustomHostname | null;
  try {
    registration = await registerHostname(config, row.hostname);
  } catch (error) {
    if (!(error instanceof ProviderError) || error.code !== "DUPLICATE") throw error;
    registration = await findHostname(config, row.hostname);
  }
  if (registration !== null) {
    await ctx.runMutation(internal.functions.customDomains.recordRegistration, {
      domainId: row._id,
      providerId: registration.id,
    });
  }
  return registration;
}

async function runCheck(ctx: ActionCtx, domainId: Doc<"customDomains">["_id"]): Promise<void> {
  const row = await ctx.runQuery(internal.functions.customDomains.rowForProvider, { domainId });
  if (row === null || (row.status !== "pending" && row.status !== "active")) return;

  const ownership = row.ownershipVerified ? true : await ownershipPublished(row.hostname, row.verifyToken);
  const findings: CheckFindings = { ownership, readiness: null };

  const config = await providerConfig(ctx);
  if (config === null) {
    findings.providerProblem = "NOT_CONFIGURED";
  } else {
    try {
      const registration = await ensureRegistration(ctx, config, row);
      findings.readiness = readinessOf(registration);
    } catch (error) {
      logFailure("check", row, error);
      findings.providerProblem = problemFor(error);
    }
  }

  await ctx.runMutation(internal.functions.customDomains.recordCheck, { domainId, findings });
}

/** First registration, and every "Check again". */
export const provision = internalAction({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await runCheck(ctx, args.domainId);
    return null;
  },
});

/** One scheduled look at DNS and the provider. */
export const check = internalAction({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await runCheck(ctx, args.domainId);
    return null;
  },
});

/**
 * Find the customer's DNS provider and, when it has our Domain Connect
 * template, record a signed link that applies both records there.
 *
 * Once, at connect. Everything that can go wrong — no signing key, a
 * self-hosted target the published template does not name, a provider without
 * the template or not answering — ends the same way: no link, and the manual
 * records the customer would have had anyway. The key is read here and never
 * leaves this action; what reaches the row is the signed link, which carries
 * nothing the owner is not already shown.
 */
export const detectProvider = internalAction({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.functions.customDomains.rowForProvider, {
      domainId: args.domainId,
    });
    if (row === null || row.status !== "pending") return null;
    if (customDomainsDeployment()?.target !== DOMAIN_CONNECT_TARGET) return null;
    const privateKey: string | null = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
      name: DOMAIN_CONNECT_SIGNING_KEY_SECRET,
    });
    if (privateKey === null || privateKey.length === 0) return null;

    const provider = await discoverProvider(row.hostname);
    if (provider === null) return null;
    // The template's CNAME sits at the host it is applied to, and a root
    // domain's host is the zone apex, where most providers refuse a CNAME. A
    // button that would fail at the provider is worse than the manual records.
    const host = hostWithinZone(row.hostname, provider.zone);
    if (host === "") return null;
    let url: string;
    try {
      url = await signedApplyUrl({
        provider,
        host,
        token: row.verifyToken,
        privateKey,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "custom_domain.domain_connect_sign_failed",
          domainId: row._id,
          detail: String((error as Error)?.message ?? ""),
        }),
      );
      return null;
    }
    await ctx.runMutation(internal.functions.customDomains.recordOneClick, {
      domainId: row._id,
      oneClick: { provider: provider.name, url },
    });
    return null;
  },
});

/**
 * Delete the provider registration, then the row.
 *
 * In that order, and the row only when the delete is confirmed: a row deleted
 * first frees the hostname while Cloudflare still serves it from our zone,
 * which is the window a takeover needs. A failure leaves the row `removing`,
 * and the sweep tries again.
 */
export const deprovision = internalAction({
  args: { domainId: v.id("customDomains") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.runQuery(internal.functions.customDomains.rowForProvider, {
      domainId: args.domainId,
    });
    if (row === null || row.status !== "removing") return null;
    const config = await providerConfig(ctx);
    if (config === null) {
      // Nothing can have been registered without a credential, unless it was
      // configured once and has since been taken away; only the first is safe
      // to finish without the provider.
      if (row.providerId === undefined) {
        await ctx.runMutation(internal.functions.customDomains.finishRemoval, { domainId: row._id });
      }
      return null;
    }
    try {
      if (row.providerId !== undefined) {
        await deleteHostname(config, row.providerId);
      } else {
        // A registration may exist whose id never reached the row.
        const orphan = await findHostname(config, row.hostname);
        if (orphan !== null) await deleteHostname(config, orphan.id);
      }
    } catch (error) {
      logFailure("deprovision", row, error);
      return null;
    }
    await ctx.runMutation(internal.functions.customDomains.finishRemoval, { domainId: row._id });
    return null;
  },
});
