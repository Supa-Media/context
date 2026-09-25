/**
 * The custom-hostname half of Cloudflare for SaaS, and nothing else.
 *
 * Four calls — register, find, read, delete — against the one zone this
 * deployment serves customer domains from, plus a pure reading of what
 * Cloudflare says about a registration. Everything here runs inside an
 * `internalAction` that has just opened the platform credential; the token is
 * on the `Authorization` header and nowhere else, and no provider text leaves
 * this module except through `ProviderError.detail`, which goes to the log and
 * never to a row.
 *
 * Why a request function of its own rather than `lib/cloudflare/request.ts`:
 * that one classifies failures into the storage-provisioning vocabulary and
 * drops the HTTP status, and the two answers this module most needs to tell
 * apart — "no such hostname" (404) and "already registered" (1406) — are
 * exactly the ones it folds together.
 */

import { CLOUDFLARE_API_BASE } from "../cloudflare/naming";

const REQUEST_TIMEOUT_MS = 15_000;

/** Cloudflare's code for registering a hostname the zone already holds. */
const DUPLICATE_HOSTNAME = 1406;

export type ProviderErrorCode = "UNAUTHORIZED" | "NOT_FOUND" | "DUPLICATE" | "REFUSED" | "UNAVAILABLE";

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    /** Provider text for the log. Never shown, never stored. */
    readonly detail: string,
  ) {
    super(`custom hostname provider: ${code}`);
    this.name = "ProviderError";
  }
}

export interface ProviderConfig {
  apiToken: string;
  zoneId: string;
}

/** The fields of a Cloudflare custom hostname this product reads. */
export interface CustomHostname {
  id: string;
  hostname: string;
  status?: string;
  verification_errors?: string[];
  /** The TXT record Cloudflare wants before it serves a hostname that is not a CNAME to us. */
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string;
    validation_errors?: { message?: string }[];
  };
}

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function call<T>(
  config: ProviderConfig,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  let response: Response;
  try {
    response = await globalThis.fetch(
      `${CLOUDFLARE_API_BASE}/zones/${encodeURIComponent(config.zoneId)}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    throw new ProviderError("UNAVAILABLE", String((error as Error)?.message ?? ""));
  }

  let envelope: Envelope<T> = {};
  try {
    const raw = await response.text();
    envelope = raw.length === 0 ? {} : (JSON.parse(raw) as Envelope<T>);
  } catch {
    envelope = {};
  }
  const detail = (envelope.errors ?? [])
    .map((entry) => [entry.code, entry.message].filter((part) => part !== undefined).join(" "))
    .join("; ")
    .slice(0, 300);

  if (response.ok && envelope.success !== false) return envelope.result as T;
  if ((envelope.errors ?? []).some((entry) => entry.code === DUPLICATE_HOSTNAME)) {
    throw new ProviderError("DUPLICATE", detail);
  }
  if (response.status === 401 || response.status === 403) throw new ProviderError("UNAUTHORIZED", detail);
  if (response.status === 404) throw new ProviderError("NOT_FOUND", detail);
  if (response.status === 429 || response.status >= 500) throw new ProviderError("UNAVAILABLE", detail);
  throw new ProviderError("REFUSED", detail);
}

/**
 * Register a hostname with HTTP certificate validation.
 *
 * HTTP rather than TXT validation because it is the one that needs nothing
 * more from the customer: once their CNAME reaches us, Cloudflare answers its
 * own challenge. Ownership is proved separately, by our own TXT record — see
 * `lib/customDomains/dns.ts` for why the CNAME alone is not enough.
 */
export async function registerHostname(
  config: ProviderConfig,
  hostname: string,
): Promise<CustomHostname> {
  return await call<CustomHostname>(config, "POST", "/custom_hostnames", {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
}

/** The zone's registration for exactly this hostname, or `null`. */
export async function findHostname(
  config: ProviderConfig,
  hostname: string,
): Promise<CustomHostname | null> {
  const rows = await call<CustomHostname[]>(
    config,
    "GET",
    `/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
  );
  // The filter is a match, not necessarily an exact one; re-check.
  return (rows ?? []).find((row) => row.hostname === hostname) ?? null;
}

export async function readHostname(
  config: ProviderConfig,
  id: string,
): Promise<CustomHostname | null> {
  try {
    return await call<CustomHostname>(config, "GET", `/custom_hostnames/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ProviderError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/**
 * Ask Cloudflare to look at a pending hostname now rather than at the next
 * step of its own backoff, by re-sending the certificate settings unchanged.
 */
export async function refreshHostname(config: ProviderConfig, id: string): Promise<CustomHostname> {
  return await call<CustomHostname>(config, "PATCH", `/custom_hostnames/${encodeURIComponent(id)}`, {
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  });
}

/** Delete a registration. Already gone is success. */
export async function deleteHostname(config: ProviderConfig, id: string): Promise<void> {
  try {
    await call<unknown>(config, "DELETE", `/custom_hostnames/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof ProviderError && error.code === "NOT_FOUND") return;
    throw error;
  }
}

/** Certificate states that will not become `active` by waiting. */
const CERTIFICATE_STUCK = new Set([
  "validation_timed_out",
  "issuance_timed_out",
  "deployment_timed_out",
  "expired",
  "deleted",
]);

export type ProviderProblem = "ROUTING_BLOCKED" | "CERTIFICATE_FAILED";

export interface ProviderReadiness {
  /** Cloudflare sees the customer's traffic arriving at our zone. */
  routing: boolean;
  /** A certificate for the hostname is issued and deployed. */
  https: boolean;
  problem: ProviderProblem | null;
  /**
   * The TXT record that lets Cloudflare serve a root domain. A root domain
   * points at us by ALIAS or a flattened CNAME, which answers with addresses
   * rather than a CNAME, and without Enterprise apex proxying Cloudflare
   * only activates such a hostname once this record is in place.
   */
  hostnameTxt?: { name: string; value: string } | null;
}

const HOSTNAME_TXT_VALUE = /^[A-Za-z0-9-]{8,100}$/;

/** Cloudflare's TXT for this hostname, only in the one shape it can take. */
export function hostnameTxtOf(registration: CustomHostname): { name: string; value: string } | null {
  const proof = registration.ownership_verification;
  if (proof === undefined || proof.type !== "txt") return null;
  if (proof.name !== `_cf-custom-hostname.${registration.hostname}`) return null;
  if (typeof proof.value !== "string" || !HOSTNAME_TXT_VALUE.test(proof.value)) return null;
  return { name: proof.name, value: proof.value };
}

/**
 * What a registration says about the two things only Cloudflare can see.
 *
 * `routing` is the hostname's own status: `active` once the customer's record
 * points at our target. `https` is the certificate's. A `blocked` or `moved`
 * hostname and a certificate in a timed-out state are problems the customer
 * has to act on; everything else pending is a wait.
 */
export function readinessOf(registration: CustomHostname | null): ProviderReadiness {
  if (registration === null) return { routing: false, https: false, problem: null, hostnameTxt: null };
  const routing = registration.status === "active";
  const https = registration.ssl?.status === "active";
  let problem: ProviderProblem | null = null;
  if (registration.status === "blocked" || registration.status === "moved") {
    problem = "ROUTING_BLOCKED";
  } else if (CERTIFICATE_STUCK.has(registration.ssl?.status ?? "")) {
    problem = "CERTIFICATE_FAILED";
  }
  return { routing, https, problem, hostnameTxt: hostnameTxtOf(registration) };
}
