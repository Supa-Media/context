/**
 * The Domain section's words and states, as pure functions.
 *
 * Every string the panel shows about a domain's state comes from here, so a
 * test can hold the copy without mounting anything. The rules it follows are
 * the Premium panel's: a status is `ok`, `warn` or `neutral` and never `crit`
 * (everything here can be fixed and nothing is lost), and the accent colour is
 * never a status.
 */

import { convexErrorParts } from "../storage/errors";

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
  purpose: "ownership" | "routing";
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
      return domain.stage === "https"
        ? { tone: "neutral", label: "Issuing certificate" }
        : { tone: "neutral", label: "Waiting for DNS" };
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

/** The sentence under the head while a domain is being set up. */
export function pendingSentence(domain: DomainView): string {
  if (domain.stage === "https") {
    return `Both records found. Setting up https for ${domain.hostname}, which usually takes a few minutes.`;
  }
  const zone = registrableDomain(domain.hostname);
  return `Add these two records where you manage ${zone}'s DNS. We check on our own, so you can close this page.`;
}

/** The sentence over the "Set up with …" button. */
export function providerSentence(provider: string): string {
  return `Your DNS is at ${provider}. Sign in there and approve, and ${provider} adds both records for you.`;
}

/** Once the provider has been opened, until the records turn up. */
export function awaySentence(provider: string): string {
  return `Finish in the ${provider} window. We'll check as soon as you're back, and on our own after that.`;
}

/** Back from the provider, and nothing found yet. */
export function notYetNote(provider: string): string {
  return `Nothing from ${provider} yet. It can take a minute to show up, and we'll keep checking.`;
}

/** The manual records, folded: which records, or how many are in. */
export function recordsSummary(records: DnsRecord[]): string {
  const found = records.filter((record) => record.done).length;
  if (found > 0 && found < records.length) return `${found} of ${records.length} found`;
  return records.map((record) => record.type).join(" and ");
}

/** The last two labels. Only used in sentences, never to route anything. */
export function registrableDomain(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

export function recordPurpose(record: DnsRecord): string {
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
