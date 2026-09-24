/**
 * One-click DNS setup through Domain Connect.
 *
 * Domain Connect is an open protocol some DNS providers (GoDaddy, IONOS and
 * others) implement: a service publishes a template of the records it needs,
 * and a customer who clicks through to their provider signs in, approves, and
 * has the records applied without copying anything. The spec lives at
 * github.com/Domain-Connect/spec; our template is `infra/domain-connect/`.
 *
 * ## What this module decides
 *
 * - **Which provider holds the zone**, from the `_domainconnect` TXT record
 *   the provider answers for every zone it hosts, then its settings endpoint.
 * - **Whether that provider has our template**, from its "query supported
 *   template" endpoint. No template, no button: the manual records stay.
 * - **The signed apply link.** The template names `syncPubKeyDomain`, so the
 *   provider checks an RSA-SHA256 signature over the query string against the
 *   public key we publish in DNS. Unsigned, a link could be forged to point
 *   somebody's domain wherever the forger liked; signed, only values we chose
 *   can be applied.
 *
 * ## What it never does
 *
 * Nothing here can make a domain live. The records the provider applies are
 * the same two the customer would paste, and the checker verifies them the
 * same way: the TXT value is still the per-claim token, so a link cannot prove
 * ownership of anything the clicker does not control at their provider.
 *
 * The template's CNAME target is fixed in the template, not a variable, which
 * is the spec's advice against open parameters. A deployment whose target is
 * not that one (a self-hosted gateway) is offered no button.
 */

import { lookupTxt } from "./dns";

/** Our identity in the public template repository. */
export const DOMAIN_CONNECT_PROVIDER_ID = "context.lc";
export const DOMAIN_CONNECT_SERVICE_ID = "website";

/** The CNAME target written into the published template. */
export const DOMAIN_CONNECT_TARGET = "customers.context.lc";

/**
 * The TXT host, under the template's `syncPubKeyDomain`, holding the public
 * half of the signing key. A rotation publishes `_dcpubkeyv2` beside it.
 */
export const DOMAIN_CONNECT_KEY_HOST = "_dcpubkeyv1";

/** The private signing key, by name in `appSecrets` (PKCS#8, PEM or bare base64). */
export const DOMAIN_CONNECT_SIGNING_KEY_SECRET = "DOMAIN_CONNECT_SIGNING_KEY";

const FETCH_TIMEOUT_MS = 5_000;

/**
 * A `_domainconnect` value is a host, optionally with a path — GoDaddy
 * answers a bare host, Cloudflare a host and a path. No scheme, no port, no
 * userinfo, no query: we add `https://` ourselves, and a value that does not
 * fit this shape is not somewhere we send a request.
 */
const PREFIX_RE =
  /^(?=.{4,253}(?:\/|$))(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[a-z0-9._~\-/]*)?$/i;

export interface DnsProvider {
  /** What the customer knows their provider as ("GoDaddy"). */
  name: string;
  /** The zone the provider hosts: `acme.com` for `docs.acme.com`. */
  zone: string;
  /** Where the synchronous flow starts, validated `https://`. */
  syncUx: string;
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
    : undefined;
}

/** An `https://` URL on a public-looking host, trailing slash trimmed; else `null`. */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return null;
  }
  if (url.search !== "" || url.hash !== "") return null;
  if (!PREFIX_RE.test(url.hostname)) return null;
  return url.toString().replace(/\/+$/, "");
}

/** The zones a hostname could live in, longest first, never a bare TLD. */
export function candidateZones(hostname: string): string[] {
  const labels = hostname.split(".");
  const zones: string[] = [];
  for (let start = 0; start <= labels.length - 2; start += 1) {
    zones.push(labels.slice(start).join("."));
  }
  return zones.slice(-4);
}

/** The host part the template is applied to: `docs` for `docs.acme.com` in `acme.com`. */
export function hostWithinZone(hostname: string, zone: string): string {
  return hostname === zone ? "" : hostname.slice(0, -(zone.length + 1));
}

async function getJson(url: string): Promise<{ status: number; body: unknown } | null> {
  const signal = timeoutSignal();
  try {
    const response = await globalThis.fetch(url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

/**
 * The provider that hosts this hostname's zone and has our template, or
 * `null` — not supported, not reachable, or not Domain Connect at all. Every
 * `null` means the same thing to the customer: add the records yourself.
 */
export async function discoverProvider(hostname: string): Promise<DnsProvider | null> {
  for (const zone of candidateZones(hostname)) {
    const answers = await lookupTxt(`_domainconnect.${zone}`);
    const prefix = answers?.map((value) => value.trim().replace(/\/+$/, "")).find((value) => PREFIX_RE.test(value));
    if (prefix === undefined) continue;

    const settings = await getJson(`https://${prefix}/v2/${encodeURIComponent(zone)}/settings`);
    if (settings === null || settings.status !== 200 || typeof settings.body !== "object" || settings.body === null) {
      continue;
    }
    const body = settings.body as Record<string, unknown>;
    const syncUx = safeHttpsUrl(body.urlSyncUX);
    const api = safeHttpsUrl(body.urlAPI);
    const rawName = typeof body.providerDisplayName === "string" && body.providerDisplayName.trim() !== ""
      ? body.providerDisplayName
      : body.providerName;
    const name = typeof rawName === "string" ? rawName.trim().slice(0, 60) : "";
    if (syncUx === null || api === null || name === "") return null;

    const template = await getJson(
      `${api}/v2/domainTemplates/providers/${DOMAIN_CONNECT_PROVIDER_ID}/services/${DOMAIN_CONNECT_SERVICE_ID}`,
    );
    if (template === null || template.status < 200 || template.status >= 300) return null;
    return { name, zone, syncUx };
  }
  return null;
}

/** The query the provider applies, in the order it is signed. */
export function applyQuery(args: { zone: string; host: string; token: string }): string {
  const params: Array<[string, string]> = [["domain", args.zone]];
  if (args.host !== "") params.push(["host", args.host]);
  params.push(["token", args.token]);
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** PKCS#8 as PEM or bare base64, to the DER bytes Web Crypto imports. */
export function pkcs8Der(key: string): Uint8Array<ArrayBuffer> {
  const body = key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  return base64ToBytes(body);
}

/** RSASSA-PKCS1-v1_5 over SHA-256, base64 — the spec's `RS256`. */
export async function signQuery(query: string, privateKey: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(query));
  return bytesToBase64(new Uint8Array(signature));
}

/**
 * The link the "Set up with …" button opens. No `redirect_uri`: the provider
 * closes its own window when it is done, and the settings panel — subscribed
 * — shows the records being found without the customer coming back to a URL.
 */
export async function signedApplyUrl(args: {
  provider: DnsProvider;
  host: string;
  token: string;
  privateKey: string;
}): Promise<string> {
  const query = applyQuery({ zone: args.provider.zone, host: args.host, token: args.token });
  const sig = await signQuery(query, args.privateKey);
  return (
    `${args.provider.syncUx}/v2/domainTemplates/providers/${DOMAIN_CONNECT_PROVIDER_ID}` +
    `/services/${DOMAIN_CONNECT_SERVICE_ID}/apply?${query}` +
    `&sig=${encodeURIComponent(sig)}&key=${DOMAIN_CONNECT_KEY_HOST}`
  );
}
