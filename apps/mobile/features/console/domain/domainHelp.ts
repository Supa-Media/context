/**
 * The help around a domain's setup, as pure functions: the company's own
 * screens, the mistakes public DNS shows, and what to say about a domain
 * before it is connected.
 *
 * Menu paths come from `@context/shared` (`dnsHosts.ts`), the same table the
 * steps email reads, so the screen and the mail never disagree. Every company
 * name passes through `providerName`'s containment: it is ours here, but the
 * one rule for every name we show keeps a new sentence from forgetting it.
 */

import { dnsHostSteps, type DnsHostSteps } from "@context/shared";
import { providerName, registrableDomain, type DnsRecord, type DomainHint, type DomainView } from "./domain";

/** The zone's own steps, in the company's words when we know the company. */
export function companySteps(domain: Pick<DomainView, "hostname" | "zone" | "dnsHost">): DnsHostSteps {
  const zone = domain.zone ?? registrableDomain(domain.hostname);
  return dnsHostSteps(
    domain.dnsHost?.key ?? null,
    domain.dnsHost === null ? null : providerName(domain.dnsHost.name),
    zone,
  );
}

/** "GoDaddy", or a plain stand-in when we don't know. */
function companyName(domain: Pick<DomainView, "dnsHost">): string {
  return domain.dnsHost === null ? "Your DNS provider" : providerName(domain.dnsHost.name);
}

/** Which record a hint belongs under, or `null` for one about the whole domain. */
export function hintRecord(hint: DomainHint): DnsRecord["purpose"] | null {
  switch (hint.code) {
    case "DOUBLED_OWNERSHIP":
      return "ownership";
    case "DOUBLED_ROUTING":
    case "PROXIED":
    case "POINTS_ELSEWHERE":
      return "routing";
    case "CAA_BLOCKS":
      return null;
  }
}

/**
 * What a hint says, in two parts: the bold finding, then what to do. Plain
 * words on the step it belongs to; never a warning box.
 */
export function hintCopy(
  domain: Pick<DomainView, "hostname" | "zone" | "dnsHost" | "records">,
  hint: DomainHint,
): { title: string; body: string } {
  const company = companyName(domain);
  const record = (purpose: DnsRecord["purpose"]) => domain.records.find((r) => r.purpose === purpose);
  switch (hint.code) {
    case "DOUBLED_OWNERSHIP":
    case "DOUBLED_ROUTING": {
      const host = record(hint.code === "DOUBLED_OWNERSHIP" ? "ownership" : "routing")?.host ?? "";
      return {
        title: "The Name has your domain twice.",
        body: `We found ${hint.name}. ${company} adds the domain itself, so the Name box should say only ${host}.`,
      };
    }
    case "PROXIED":
      return {
        title: "The orange cloud is on.",
        body: `In Cloudflare's DNS list, press the orange cloud next to ${record("routing")?.host ?? domain.hostname} so it turns grey and says DNS only.`,
      };
    case "CAA_BLOCKS":
      return {
        title: "An old setting is blocking the secure lock.",
        body: `${hint.name} has a CAA record that only lets other companies make certificates. Add 0 issue "letsencrypt.org" and 0 issue "pki.goog" to it, or delete it if you didn't add it on purpose.`,
      };
    case "POINTS_ELSEWHERE": {
      const what =
        hint.site === "parked"
          ? `${company}'s parked page`
          : hint.site !== null
            ? `a ${hint.site} website`
            : hint.value !== null
              ? hint.value
              : "something else";
      return {
        title: `${domain.hostname} still points to ${what}.`,
        body: "Change that record to the one below. Leave your mail settings as they are.",
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Before connecting                                                           */
/* -------------------------------------------------------------------------- */

export type CurrentAnswer =
  | { kind: "empty" }
  | { kind: "ours" }
  | { kind: "site"; site: string }
  | { kind: "parked" }
  | { kind: "elsewhere"; value: string };

/** `customDomainsLookup.lookup`'s answer. */
export type DomainLookup =
  | { ok: false; message: string }
  | {
      ok: true;
      hostname: string;
      zone: string;
      apex: boolean;
      dnsHost: { key: string; name: string } | null;
      rootCanPoint: boolean | null;
      current: CurrentAnswer | null;
      wwwCurrent: CurrentAnswer | null;
    };

export interface AddressChoice {
  /** The hostname that would be connected; `""` for "a part of it", typed below. */
  value: string;
  label: string;
  detail: string;
  recommended: boolean;
}

/**
 * Which addresses to offer for what was typed. A subdomain is offered as is.
 * A root domain is offered as itself where its company can point a root,
 * and as `www.` plus forwarding where it cannot, which is the default there
 * rather than a footnote.
 */
export function addressChoices(lookup: Extract<DomainLookup, { ok: true }>): AddressChoice[] {
  const company = lookup.dnsHost === null ? null : providerName(lookup.dnsHost.name);
  const part: AddressChoice = {
    value: "",
    label: `A part of it, like blog.${lookup.zone}`,
    detail: `Keeps ${lookup.zone} for something else.`,
    recommended: false,
  };
  if (!lookup.apex) {
    return [{ value: lookup.hostname, label: lookup.hostname, detail: "", recommended: true }];
  }
  const www: AddressChoice = {
    value: `www.${lookup.zone}`,
    label: `www.${lookup.zone}`,
    detail: `People who type ${lookup.zone} are sent here by ${company ?? "your DNS provider"}. One extra setting, and we show you where.`,
    recommended: lookup.rootCanPoint === false,
  };
  if (lookup.rootCanPoint === false) return [www, part];
  return [
    {
      value: lookup.zone,
      label: lookup.zone,
      detail: `www.${lookup.zone} works too.`,
      recommended: true,
    },
    { ...www, detail: `People who type ${lookup.zone} are sent here.` },
    part,
  ];
}

/** The quiet lines under the field: where the settings are, what's there now, mail. */
export function lookupLines(lookup: Extract<DomainLookup, { ok: true }>, chosen: string): string[] {
  const lines: string[] = [];
  if (lookup.dnsHost !== null) lines.push(`Its settings are at ${providerName(lookup.dnsHost.name)}.`);
  const current = chosen.startsWith("www.") && lookup.apex ? lookup.wwwCurrent : lookup.current;
  if (current?.kind === "parked") lines.push("It shows a parked page now. Setting up replaces that page.");
  if (current?.kind === "empty") lines.push("Nothing is there yet.");
  lines.push("Your email keeps working. We never change mail settings.");
  return lines;
}

/**
 * The one red line: connecting `chosen` replaces a website that is there
 * now. `null` when nothing would be lost.
 */
export function replacesSite(lookup: Extract<DomainLookup, { ok: true }>, chosen: string): string | null {
  const current = chosen === `www.${lookup.zone}` && lookup.apex ? lookup.wwwCurrent : chosen === lookup.hostname ? lookup.current : null;
  if (current?.kind === "site") return `A ${current.site} website is on ${chosen} now. Connecting replaces that website.`;
  if (current?.kind === "elsewhere") return `${chosen} points somewhere else now. Connecting replaces whatever is there.`;
  return null;
}
