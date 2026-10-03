/**
 * The sites domain: every workspace's published website at
 * `<handle>.ctxlc.site`, beside `context.lc/@handle`.
 *
 * A domain of its own, on the Public Suffix List, so each site is its own
 * origin and nothing a site ever runs shares one with `context.lc`, where
 * people are signed in. It serves exactly what `context.lc/@handle` serves:
 * the same release, narrowed by the same `privacy.md`. The address publishes
 * nothing that was not already published.
 *
 * Kept free of relative imports, like `websiteRoutes.ts`, so node can load it.
 */

export const SITES_DOMAIN = "ctxlc.site";

/** A DNS label that is also a handle: no leading or trailing hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * `acme.ctxlc.site` → `acme`. Anything else — the bare domain, `www.`, a
 * deeper name, a label no handle can have — is `null`.
 */
export function sitesSubdomainHandle(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  const suffix = `.${SITES_DOMAIN}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  // `xn--` and any `??--` is how DNS spells a Unicode name, which a browser
  // shows as that name: a lookalike of somebody else's site on our domain.
  if (!LABEL.test(label) || label === "www" || label.slice(2, 4) === "--") return null;
  return label;
}

/** The address a workspace's site has on the sites domain. */
export function sitesDomainAddress(handle: string): string {
  return `${handle}.${SITES_DOMAIN}`;
}
