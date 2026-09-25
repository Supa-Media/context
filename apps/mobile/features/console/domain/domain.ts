/**
 * The Website section's words and states, as pure functions.
 *
 * Every string the panel shows about a domain's state comes from here, so a
 * test can hold the copy without mounting anything. The rules it follows are
 * the Premium panel's: a status is `ok`, `warn` or `neutral` and never `crit`
 * (everything here can be fixed and nothing is lost), and the accent colour is
 * never a status.
 */

import { convexErrorParts } from "../storage/errors";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";

export type DomainStatus = "pending" | "active" | "suspended" | "removing";
export type DomainStage = "ownership" | "routing" | "https" | "live";
export type DomainProblem =
  | "NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REFUSED"
  | "ROUTING_BLOCKED"
  | "CERTIFICATE_FAILED"
  | "TIMED_OUT";

export interface DnsRecord {
  purpose: "ownership" | "routing" | "hostname";
  type: string;
  name: string;
  host: string;
  value: string;
  done: boolean;
}

export interface DomainView {
  id: string;
  hostname: string;
  apex: boolean;
  status: DomainStatus;
  stage: DomainStage;
  ownershipVerified: boolean;
  routingVerified: boolean;
  httpsReady: boolean;
  problem: string | null;
  homeSlug: string | null;
  checkedAt: number | null;
  /** When this round of checks began. */
  checkingSince: number;
  records: DnsRecord[];
  /** Owner only, while records are missing: the provider can add them for you. */
  oneClick: OneClick | null;
}

export interface OneClick {
  provider: string;
  url: string;
}

export interface DomainSettings {
  available: boolean;
  paying: boolean;
  canManage: boolean;
  domain: DomainView | null;
}

export type PillTone = "ok" | "warn" | "neutral";

/** Problems the owner has to act on. The rest are ours, and we retry them. */
const NEEDS_ATTENTION = new Set<string>([
  "PROVIDER_REFUSED",
  "ROUTING_BLOCKED",
  "CERTIFICATE_FAILED",
  "TIMED_OUT",
]);

export function needsAttention(domain: Pick<DomainView, "status" | "problem">): boolean {
  return domain.status === "pending" && domain.problem !== null && NEEDS_ATTENTION.has(domain.problem);
}

export function domainPill(domain: DomainView): { tone: PillTone; label: string } {
  switch (domain.status) {
    case "active":
      return { tone: "ok", label: "Live" };
    case "suspended":
      return { tone: "warn", label: "Paused" };
    case "removing":
      return { tone: "neutral", label: "Removing" };
    case "pending":
      if (needsAttention(domain)) return { tone: "warn", label: "Needs attention" };
      if (domain.stage === "https") return { tone: "neutral", label: "Securing" };
      return domain.stage === "routing"
        ? { tone: "neutral", label: "Connecting" }
        : { tone: "neutral", label: "Add records" };
  }
}

export interface DomainStep {
  label: string;
  state: "done" | "current" | "todo";
}

/** The three checks, in the order a domain passes them. */
export function domainSteps(domain: DomainView): DomainStep[] {
  const facts = [
    { label: "Verified", done: domain.ownershipVerified },
    { label: "Connected", done: domain.routingVerified },
    { label: "HTTPS", done: domain.httpsReady },
  ];
  let currentGiven = false;
  return facts.map(({ label, done }) => {
    if (done) return { label, state: "done" };
    if (!currentGiven) {
      currentGiven = true;
      return { label, state: "current" };
    }
    return { label, state: "todo" };
  });
}

/** "Step 2 of 3: connected" — one label for the whole row. */
export function stepsLabel(steps: DomainStep[]): string {
  const index = steps.findIndex((step) => step.state === "current");
  if (index === -1) return "All three checks passed";
  return `Step ${index + 1} of ${steps.length}: ${steps[index]!.label.toLowerCase()}`;
}

/**
 * How long a pointing record usually takes to reach us. Past it, "Checking"
 * turns into "Not seen yet" and the sentence asks the owner to look.
 */
export const USUAL_CONNECT_MS = 30 * 60 * 1000;

function waitedLong(domain: DomainView, now: number): boolean {
  return now - domain.checkingSince >= USUAL_CONNECT_MS;
}

const COUNT_WORDS = ["no", "one", "two", "three", "four"];

/** "the ALIAS record", "the ALIAS and _cf-custom-hostname TXT records". */
function recordList(records: DnsRecord[]): string {
  const names = records.map((record) => (record.type === "TXT" ? `${record.host} TXT` : record.type));
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
  return `the ${joined} record${records.length > 1 ? "s" : ""}`;
}

/**
 * The sentence under the head while a domain is being set up. It says what is
 * done and what is left, and says so plainly when nothing is left to do.
 */
export function pendingSentence(domain: DomainView, now: number = Date.now()): string {
  if (domain.stage === "https") {
    return "Your records are in. Setting up HTTPS, which usually takes a few minutes. There's nothing to do.";
  }
  if (domain.stage !== "routing") {
    const zone = registrableDomain(domain.hostname);
    const count = COUNT_WORDS[domain.records.length] ?? String(domain.records.length);
    return `Add these ${count} records where you manage ${zone}'s DNS. We check on our own, so you can close this page.`;
  }
  const missing = domain.records.filter((record) => !record.done);
  if (missing.length === 0) {
    return `${domain.hostname} is yours. Connecting usually takes under 30 minutes, and you can close this page.`;
  }
  if (!waitedLong(domain, now)) {
    return `${domain.hostname} is yours. If you've added ${recordList(missing)}, there's nothing more to do. Connecting usually takes under 30 minutes, and you can close this page.`;
  }
  const them = missing.length > 1 ? "they match" : "it matches";
  return `We haven't seen ${recordList(missing)} reach us yet. Check ${them} below at your DNS provider. Some providers take a few hours.`;
}

/**
 * One record's status. A record we have not found reads "Checking" while it
 * is still normal not to see it, and "Not seen yet" otherwise — dashed, since
 * neither is a check that said no: a pointing record cannot be seen at all
 * until Cloudflare takes the domain on.
 */
export function recordStatus(
  domain: DomainView,
  record: DnsRecord,
  now: number = Date.now(),
): { label: string; tone: "ok" | "neutral"; dashed: boolean } {
  if (record.done) return { label: "Found", tone: "ok", dashed: false };
  const checking = domain.stage === "routing" && record.purpose !== "ownership" && !waitedLong(domain, now);
  return { label: checking ? "Checking" : "Not seen yet", tone: "neutral", dashed: true };
}

/** Under the ALIAS record of a root domain, while it has not been found. */
export function apexNote(hostname: string): string {
  return `On ${hostname} itself, use ALIAS or ANAME. On Cloudflare, a CNAME works. No option for this? Connect www.${hostname} instead.`;
}

/**
 * The DNS provider's own name for itself, contained.
 *
 * `providerDisplayName` comes back in an HTTP response from whatever host the
 * `_domainconnect` TXT record named, and zone discovery walks up to the parent
 * zones of the hostname being claimed — so for a subdomain of somebody else's
 * zone the string belongs to that zone's operator, not to the person reading
 * it. It is then spoken in the console's own voice, in a sentence that tells
 * the reader to sign in at the named provider.
 *
 * `isolateForDisplay` contains rather than cleans, for the reason its header
 * gives, and adds nothing to a name with nothing hostile in it. The sixty-
 * character cap on the write side is a bound on length and not a container.
 *
 * Every sentence below takes the raw name and contains it here, so a new one
 * cannot be written that forgets to.
 */
export function providerName(provider: string): string {
  return isolateForDisplay(provider);
}

/** The sentence over the "Set up with …" button. */
export function providerSentence(provider: string): string {
  const name = providerName(provider);
  return `Your DNS is at ${name}. Sign in there and approve, and ${name} adds both records for you.`;
}

/** Once the provider has been opened, until the records turn up. */
export function awaySentence(provider: string): string {
  return `Finish in the ${providerName(provider)} window. We'll check as soon as you're back, and on our own after that.`;
}

/** Back from the provider, and nothing found yet. */
export function notYetNote(provider: string): string {
  return `Nothing from ${providerName(provider)} yet. It can take a minute to show up, and we'll keep checking.`;
}

/** The records, folded: how many are in, or which they are. */
export function recordsSummary(records: DnsRecord[]): string {
  const found = records.filter((record) => record.done).length;
  if (found > 0 && found < records.length) return `${found} of ${records.length} found`;
  if (found > 0) return records.length === 2 ? "Both found" : "All found";
  return records.length === 2 ? records.map((record) => record.type).join(" and ") : `${records.length} records`;
}

/** The last two labels. Only used in sentences, never to route anything. */
export function registrableDomain(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

export function recordPurpose(record: DnsRecord): string {
  if (record.purpose === "hostname") return "Lets us serve your root domain";
  return record.purpose === "routing" ? "Points your domain at Context" : "Proves the domain is yours";
}

/** What a stuck domain tells its owner, in their words rather than the provider's. */
export function problemCopy(domain: DomainView): { title: string; body: string } | null {
  if (!needsAttention(domain)) return null;
  switch (domain.problem) {
    case "ROUTING_BLOCKED":
      return {
        title: "The record points somewhere else",
        body: `${domain.hostname} isn't reaching Context. Check the ${domain.apex ? "ALIAS" : "CNAME"} record below matches exactly.`,
      };
    case "CERTIFICATE_FAILED":
      return {
        title: "Your DNS is blocking the certificate",
        body: `A CAA record on ${registrableDomain(domain.hostname)} may not allow our certificate providers. Remove it, or add letsencrypt.org and pki.goog, then check again.`,
      };
    case "TIMED_OUT":
      return {
        title: "We stopped checking",
        body: "We haven't seen both records in three days. Check them below, then check again.",
      };
    default:
      return {
        title: "This domain couldn't be set up",
        body: "Our certificate provider turned it down. Check the name is right, or remove it and connect it again.",
      };
  }
}

/** A quiet line for problems that are ours to retry. */
export function transientNote(domain: DomainView): string | null {
  if (domain.status !== "pending" || domain.problem === null || needsAttention(domain)) return null;
  return domain.problem === "NOT_CONFIGURED"
    ? "Context is finishing its side of the setup. We'll keep checking."
    : "We couldn't finish a check just now. We'll try again shortly.";
}

/**
 * The client's shape check: forgiving about what people paste, and only ever
 * a hint — the server normalises and re-checks everything.
 */
export function cleanDomainInput(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/, 1)[0]!
    .replace(/\.$/, "");
}

export function domainShapeProblem(cleaned: string): string | null {
  if (cleaned === "") return null;
  if (cleaned === "context.lc" || cleaned.endsWith(".context.lc")) {
    return "That address is ours. Use a domain you own.";
  }
  const labels = cleaned.split(".");
  const wellFormed =
    labels.length >= 2 &&
    labels.every((label) => /^(?:[a-z0-9¡-￿](?:[a-z0-9¡-￿-]{0,61}[a-z0-9¡-￿])?)$/.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1]!);
  return wellFormed ? null : "That doesn't look like a domain. Try something like docs.acme.com.";
}

/** Where a refused request's message goes: under the field, or under the button. */
export function describeDomainFailure(error: unknown): { field?: string; form?: string } {
  const { code, message } = convexErrorParts(error);
  switch (code) {
    case "INVALID_HOSTNAME":
      return { field: message ?? "That doesn't look like a domain." };
    case "HOSTNAME_TAKEN":
      return {
        field: "That domain is already connected to a Context workspace. If it's yours, remove it there first.",
      };
    case "LIMIT_REACHED":
    case "PREMIUM_REQUIRED":
    case "NOT_CONFIGURED":
    case "LINK_NOT_FOUND":
      return { form: message ?? "That didn't go through." };
    default:
      return { form: "That did not go through. Check your connection and try again." };
  }
}

/** The address a live domain serves a short link at. */
export function domainUrl(hostname: string, slug?: string): string {
  return slug === undefined ? `https://${hostname}` : `https://${hostname}/${slug}`;
}
