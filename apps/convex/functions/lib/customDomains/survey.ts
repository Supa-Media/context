/**
 * Looking at a domain the way its owner would have to, so the screen can say
 * what to do there instead of handing over records and hoping.
 *
 * Everything here reads public DNS over HTTPS (`dns.ts`) and nothing writes
 * anywhere. Each question can go unanswered — a resolver timeout, a zone that
 * refuses a type — and an unanswered question is `null` or an empty list,
 * never a guess dressed as a finding: the setup still works with the records
 * alone, as it did before any of this existed.
 *
 * What it finds:
 *
 *  - **where the zone starts**, from the SOA record, so a record's Name is
 *    written relative to the real zone (`acme.co.uk` has three labels);
 *  - **which company runs the DNS**, from the zone's name servers, so the
 *    steps can name their screens and say whether the root can point at us;
 *  - **what the name answers today**, so an existing website is not replaced
 *    by surprise and a leftover record is named;
 *  - **the usual mistakes**: the Name typed with the domain on it (which most
 *    forms then double), Cloudflare's proxy hiding the record, and a CAA
 *    record that forbids our certificate issuers.
 *
 * Mail is never read and never mentioned as something to change: MX, SPF and
 * every name other than the one being connected are out of scope by design.
 */

import { dohQuery, ownershipRecordName, ownershipRecordValue, RR, unquoteTxt, type DohRecord } from "./dns";

/** A company that runs DNS, as far as its name servers say. */
export interface DnsHost {
  key: DnsHostKey;
  name: string;
}

/** The companies whose screens the app knows how to describe. */
export type DnsHostKey =
  | "godaddy"
  | "namecheap"
  | "squarespace"
  | "cloudflare"
  | "porkbun"
  | "route53"
  | "ionos"
  | "hover"
  | "namecom"
  | "dnsimple"
  | "wix"
  | "vercel"
  | "digitalocean";

/** Name-server suffix → company. A suffix, so `ns07.domaincontrol.com` matches. */
const NAME_SERVERS: [suffix: string, key: DnsHostKey, name: string][] = [
  ["domaincontrol.com", "godaddy", "GoDaddy"],
  ["registrar-servers.com", "namecheap", "Namecheap"],
  ["googledomains.com", "squarespace", "Squarespace"],
  ["squarespacedns.com", "squarespace", "Squarespace"],
  ["ns.cloudflare.com", "cloudflare", "Cloudflare"],
  ["porkbun.com", "porkbun", "Porkbun"],
  ["awsdns", "route53", "Amazon Route 53"],
  ["ui-dns.com", "ionos", "IONOS"],
  ["ui-dns.de", "ionos", "IONOS"],
  ["ui-dns.org", "ionos", "IONOS"],
  ["ui-dns.biz", "ionos", "IONOS"],
  ["hover.com", "hover", "Hover"],
  ["name.com", "namecom", "Name.com"],
  ["dnsimple.com", "dnsimple", "DNSimple"],
  ["dnsimple-edge.net", "dnsimple", "DNSimple"],
  ["wixdns.net", "wix", "Wix"],
  ["vercel-dns.com", "vercel", "Vercel"],
  ["digitalocean.com", "digitalocean", "DigitalOcean"],
];

/**
 * Whether a company can point a root domain (`acme.com` itself) at a name
 * rather than an address — ALIAS, ANAME or CNAME flattening. `false` means
 * the root cannot reach us there, so `www.` plus their forwarding is the way.
 * Absent: we don't know, and the screen offers both.
 */
const ROOT_CAN_POINT: Partial<Record<DnsHostKey, boolean>> = {
  godaddy: false,
  squarespace: false,
  wix: false,
  namecheap: true,
  cloudflare: true,
  porkbun: true,
  route53: false,
  dnsimple: true,
  namecom: true,
  vercel: true,
  digitalocean: false,
  hover: false,
  ionos: false,
};

export function dnsHostFor(nameServers: string[]): DnsHost | null {
  for (const server of nameServers) {
    const host = server.toLowerCase().replace(/\.$/, "");
    for (const [suffix, key, name] of NAME_SERVERS) {
      if (suffix === "awsdns" ? /\.awsdns-\d+\./.test(`${host}.`) : host === suffix || host.endsWith(`.${suffix}`)) {
        return { key, name };
      }
    }
  }
  return null;
}

export function rootCanPoint(host: DnsHost | null): boolean | null {
  if (host === null) return null;
  return ROOT_CAN_POINT[host.key] ?? null;
}

/** Website builders and hosts, by the name their CNAME targets end in. */
const SITE_HOSTS: [suffix: string, name: string][] = [
  ["squarespace.com", "Squarespace"],
  ["wixdns.net", "Wix"],
  ["wix.com", "Wix"],
  ["myshopify.com", "Shopify"],
  ["shops.myshopify.com", "Shopify"],
  ["ghs.googlehosted.com", "Google Sites"],
  ["github.io", "GitHub Pages"],
  ["netlify.app", "Netlify"],
  ["vercel-dns.com", "Vercel"],
  ["webflow.io", "Webflow"],
  ["proxy-ssl.webflow.com", "Webflow"],
  ["substack-custom-domains.com", "Substack"],
  ["ghost.io", "Ghost"],
  ["wordpress.com", "WordPress.com"],
  ["carrd.co", "Carrd"],
  ["framer.app", "Framer"],
];

/** Registrars' own "parked" pages, by CNAME target. */
const PARKING_HOSTS = ["parkingpage.namecheap.com", "parked.porkbun.com", "uixie.porkbun.com"];

/** What a name answers today. */
export type CurrentAnswer =
  | { kind: "empty" }
  | { kind: "ours" }
  | { kind: "site"; site: string }
  | { kind: "parked" }
  /** Something else: a CNAME target or addresses, shown as the record says. */
  | { kind: "elsewhere"; value: string };

function bare(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

/** Classify an A query's answer — which follows any CNAME chain — for `hostname`. */
export function classifyAnswer(hostname: string, answer: DohRecord[], target: string | null): CurrentAnswer {
  const cnames = answer.filter((record) => record.type === RR.CNAME).map((record) => bare(record.data));
  const addresses = answer.filter((record) => record.type === RR.A || record.type === RR.AAAA);
  if (cnames.length === 0 && addresses.length === 0) return { kind: "empty" };
  if (target !== null && cnames.includes(bare(target))) return { kind: "ours" };
  for (const cname of cnames) {
    if (PARKING_HOSTS.some((suffix) => cname === suffix || cname.endsWith(`.${suffix}`))) return { kind: "parked" };
    const site = SITE_HOSTS.find(([suffix]) => cname === suffix || cname.endsWith(`.${suffix}`));
    if (site !== undefined) return { kind: "site", site: site[1] };
  }
  const first = cnames[0];
  if (first !== undefined && first !== bare(hostname)) return { kind: "elsewhere", value: first };
  return { kind: "elsewhere", value: addresses.map((record) => record.data).slice(0, 2).join(", ") };
}

/** Cloudflare's published edge ranges (IPv4), enough to tell a proxied record. */
const CLOUDFLARE_V4: [base: string, bits: number][] = [
  ["173.245.48.0", 20],
  ["103.21.244.0", 22],
  ["103.22.200.0", 22],
  ["103.31.4.0", 22],
  ["141.101.64.0", 18],
  ["108.162.192.0", 18],
  ["190.93.240.0", 20],
  ["188.114.96.0", 20],
  ["197.234.240.0", 22],
  ["198.41.128.0", 17],
  ["162.158.0.0", 15],
  ["104.16.0.0", 13],
  ["104.24.0.0", 14],
  ["172.64.0.0", 13],
  ["131.0.72.0", 22],
];

function ipv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!/^\d{1,3}$/.test(part) || n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

export function isCloudflareAddress(value: string): boolean {
  const ip = ipv4(value);
  if (ip === null) return false;
  return CLOUDFLARE_V4.some(([base, bits]) => {
    const start = ipv4(base)!;
    const size = 2 ** (32 - bits);
    return ip >= start && ip < start + size;
  });
}

/**
 * A record behind Cloudflare's proxy (the orange cloud) answers with
 * Cloudflare's own addresses and hides the CNAME, so we can neither see it
 * nor serve the name. Only a subdomain can be told apart: at the root,
 * Cloudflare flattens a correct CNAME to the same addresses.
 */
export function looksProxied(host: DnsHost | null, apex: boolean, answer: DohRecord[]): boolean {
  if (host?.key !== "cloudflare" || apex) return false;
  if (answer.some((record) => record.type === RR.CNAME)) return false;
  const addresses = answer.filter((record) => record.type === RR.A);
  return addresses.length > 0 && addresses.every((record) => isCloudflareAddress(record.data));
}

/** The issuers Cloudflare uses for customer hostnames' certificates. */
export const OUR_ISSUERS = ["letsencrypt.org", "pki.goog", "ssl.com"];

/**
 * Does a CAA record set forbid every issuer we use? Only `issue` tags count;
 * no `issue` tag at all means anybody may issue.
 */
export function caaBlocks(records: DohRecord[]): boolean {
  const issuers: string[] = [];
  for (const record of records) {
    if (record.type !== RR.CAA) continue;
    const match = /^\s*\d+\s+issue\s+"?([^";\s]*)/i.exec(record.data);
    if (match !== null) issuers.push((match[1] ?? "").toLowerCase());
  }
  if (issuers.length === 0) return false;
  return !issuers.some((issuer) => OUR_ISSUERS.includes(issuer));
}

/** The names from `hostname` up to (not past) the registrable-looking end. */
export function namesUpward(hostname: string): string[] {
  const labels = hostname.split(".");
  const out: string[] = [];
  for (let i = 0; i < labels.length - 1; i += 1) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * Where the zone holding `hostname` starts: the closest name, going up, that
 * has its own SOA record. `null` if nothing answered.
 */
export async function findZone(hostname: string): Promise<string | null> {
  const names = namesUpward(hostname);
  const answers = await Promise.all(names.map((name) => dohQuery(name, "SOA")));
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]!;
    const result = answers[i];
    if (result?.answer.some((record) => record.type === RR.SOA && bare(record.name) === name)) return name;
  }
  return null;
}

export async function dnsHostOf(zone: string): Promise<DnsHost | null> {
  const result = await dohQuery(zone, "NS");
  if (result === null) return null;
  return dnsHostFor(result.answer.filter((record) => record.type === RR.NS).map((record) => record.data));
}

/** What `hostname` answers today, and the raw answer for the proxy check. */
export async function currentAnswerOf(
  hostname: string,
  target: string | null,
): Promise<{ current: CurrentAnswer; answer: DohRecord[] } | null> {
  const result = await dohQuery(hostname, "A");
  if (result === null) return null;
  return { current: classifyAnswer(hostname, result.answer, target), answer: result.answer };
}

/** The CAA set in force for `hostname`: the closest name upward that has one. */
export async function caaInForce(hostname: string, zone: string | null): Promise<DohRecord[]> {
  const names = namesUpward(hostname).filter((name) => zone === null || name === zone || name.endsWith(`.${zone}`));
  const answers = await Promise.all(names.map((name) => dohQuery(name, "CAA")));
  for (let i = 0; i < names.length; i += 1) {
    const found = (answers[i]?.answer ?? []).filter((record) => record.type === RR.CAA && bare(record.name) === names[i]);
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * Before connecting: the facts the screen needs to recommend an address.
 * Read-only and safe to run on a name nobody has claimed.
 */
export interface DomainLookup {
  hostname: string;
  /** Where the zone starts, when the resolver said; else the last two labels. */
  zone: string;
  /** `hostname` is the zone's own root. */
  apex: boolean;
  dnsHost: DnsHost | null;
  /** The root can point at us at this company. `null`: unknown. */
  rootCanPoint: boolean | null;
  current: CurrentAnswer | null;
  /** For a root domain: what its `www.` answers today. */
  wwwCurrent: CurrentAnswer | null;
}

export async function lookupDomain(hostname: string, target: string | null): Promise<DomainLookup> {
  const zone = (await findZone(hostname)) ?? hostname.split(".").slice(-2).join(".");
  const apex = zone === hostname;
  const [dnsHost, current, wwwCurrent] = await Promise.all([
    dnsHostOf(zone),
    currentAnswerOf(hostname, target),
    apex ? currentAnswerOf(`www.${hostname}`, target) : Promise.resolve(null),
  ]);
  return {
    hostname,
    zone,
    apex,
    dnsHost,
    rootCanPoint: rootCanPoint(dnsHost),
    current: current?.current ?? null,
    wwwCurrent: wwwCurrent?.current ?? null,
  };
}

/** A mistake the setup screen names on the step it belongs to. */
export type DomainHint =
  /** The ownership TXT was published with the zone written twice. */
  | { code: "DOUBLED_OWNERSHIP"; name: string }
  /** The pointing record was published with the zone written twice. */
  | { code: "DOUBLED_ROUTING"; name: string }
  /** Cloudflare's proxy is on for the name. */
  | { code: "PROXIED" }
  /** A CAA record forbids every issuer we use. */
  | { code: "CAA_BLOCKS"; name: string }
  /** The name still answers with something that isn't us. */
  | { code: "POINTS_ELSEWHERE"; site: string | null; value: string | null };

export interface DomainSurvey {
  zone: string | null;
  dnsHost: DnsHost | null;
  hints: DomainHint[];
}

/** `_context.docs.acme.com` → `_context.docs.acme.com.acme.com`: what a form makes of a full name. */
export function doubledName(fullName: string, zone: string): string {
  return `${fullName}.${zone}`;
}

/**
 * While a domain is being set up: what is in the way. Run beside each check,
 * so the screen can say what is wrong rather than "not seen yet".
 */
export async function surveyDomain(input: {
  hostname: string;
  verifyToken: string;
  target: string;
  ownershipVerified: boolean;
  routingVerified: boolean;
}): Promise<DomainSurvey> {
  const zone = await findZone(input.hostname);
  const effectiveZone = zone ?? input.hostname.split(".").slice(-2).join(".");
  const apex = effectiveZone === input.hostname;
  const ownershipName = ownershipRecordName(input.hostname);
  const [dnsHost, now, doubledTxt, doubledRouting, caa] = await Promise.all([
    dnsHostOf(effectiveZone),
    input.routingVerified ? Promise.resolve(null) : currentAnswerOf(input.hostname, input.target),
    input.ownershipVerified ? Promise.resolve(null) : dohQuery(doubledName(ownershipName, effectiveZone), "TXT"),
    input.routingVerified || apex ? Promise.resolve(null) : dohQuery(doubledName(input.hostname, effectiveZone), "CNAME"),
    caaInForce(input.hostname, zone),
  ]);
  const hints: DomainHint[] = [];
  const expected = ownershipRecordValue(input.verifyToken);
  if (doubledTxt?.answer.some((record) => record.type === RR.TXT && unquoteTxt(record.data).trim() === expected)) {
    hints.push({ code: "DOUBLED_OWNERSHIP", name: doubledName(ownershipName, effectiveZone) });
  }
  if (doubledRouting?.answer.some((record) => record.type === RR.CNAME && bare(record.data) === bare(input.target))) {
    hints.push({ code: "DOUBLED_ROUTING", name: doubledName(input.hostname, effectiveZone) });
  }
  if (now !== null) {
    if (looksProxied(dnsHost, apex, now.answer)) {
      hints.push({ code: "PROXIED" });
    } else if (now.current.kind === "site" || now.current.kind === "parked" || now.current.kind === "elsewhere") {
      hints.push({
        code: "POINTS_ELSEWHERE",
        site: now.current.kind === "site" ? now.current.site : now.current.kind === "parked" ? "parked" : null,
        value: now.current.kind === "elsewhere" ? now.current.value : null,
      });
    }
  }
  if (caaBlocks(caa)) hints.push({ code: "CAA_BLOCKS", name: bare(caa[0]!.name) });
  return { zone, dnsHost, hints };
}

/**
 * For `www.<root>` connected on its own: does the root send visitors to it?
 * The registrar's forwarding answers plain HTTP with a redirect. `null`: no
 * answer at all.
 */
export async function rootForwards(wwwHostname: string): Promise<boolean | null> {
  if (!wwwHostname.startsWith("www.")) return null;
  const root = wwwHostname.slice(4);
  try {
    const response = await globalThis.fetch(`http://${root}/`, {
      method: "GET",
      redirect: "manual",
      ...(typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? { signal: AbortSignal.timeout(5_000) }
        : {}),
    });
    if (response.status < 300 || response.status >= 400) return false;
    const location = response.headers.get("location");
    if (location === null) return false;
    return new URL(location, `http://${root}/`).hostname.toLowerCase() === wwwHostname;
  } catch {
    return null;
  }
}
