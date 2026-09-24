/**
 * Whether this deployment serves customer domains, and where.
 *
 * Two identifiers in environment variables and one credential in `appSecrets`,
 * split the way `managedStorage.ts` splits `MANAGED_R2_ACCOUNT_ID` from its
 * token and for the same reason: public queries need to know whether the
 * feature exists without ever being a path to a decryptable secret.
 *
 * Absent is an ordinary state. A self-hosted deployment, or ours before the
 * platform setup is finished, simply does not offer custom domains, and the
 * settings screen says so in one sentence instead of showing a form that
 * cannot work.
 */

/** The Cloudflare zone that holds customer hostnames (Cloudflare for SaaS). */
export const CUSTOM_DOMAINS_ZONE_ENV_VAR = "CUSTOM_DOMAINS_ZONE_ID";

/**
 * The hostname customers point their CNAME at — the zone's SaaS fallback
 * origin. Public by design: it is printed on the settings screen.
 */
export const CUSTOM_DOMAINS_TARGET_ENV_VAR = "CUSTOM_DOMAINS_TARGET";

/**
 * The credential that registers and removes hostnames, by name in `appSecrets`.
 * Zone-scoped to SSL and Certificates: Edit on the one zone above.
 */
export const CUSTOM_DOMAINS_TOKEN_SECRET = "CUSTOM_DOMAINS_API_TOKEN";

const ZONE_ID_RE = /^[0-9a-f]{32}$/;
const TARGET_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface CustomDomainsDeployment {
  zoneId: string;
  target: string;
}

/** Both identifiers, well-formed, or `null`. Half-configured reads as off. */
export function customDomainsDeployment(): CustomDomainsDeployment | null {
  const zoneId = (process.env[CUSTOM_DOMAINS_ZONE_ENV_VAR] ?? "").trim();
  const target = (process.env[CUSTOM_DOMAINS_TARGET_ENV_VAR] ?? "").trim().toLowerCase();
  if (!ZONE_ID_RE.test(zoneId) || !TARGET_RE.test(target)) return null;
  return { zoneId, target };
}
