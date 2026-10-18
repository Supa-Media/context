/**
 * Where things are at the companies that run people's DNS, in their own words.
 *
 * Shared by the setup screen (`apps/mobile/features/console/domain`) and the
 * mail that sends the same steps to whoever runs a domain
 * (`apps/convex/functions/customDomainsMail.ts`), so the two can never tell
 * somebody different things. Keys are the ones `survey.ts` in the control
 * plane derives from a zone's name servers.
 *
 * Kept to menu names, not screenshots: a menu path survives a redesign far
 * longer than a picture of a form does. A company not listed gets plain
 * steps that name it, and nothing at all is said about mail.
 */

export interface DnsHostSteps {
  /** How to reach the list of DNS records for the zone. */
  open: string;
  /** How to start a new record, ending where the boxes are filled in. */
  add: string;
  /** How to send `zone` to `https://www.<zone>`. */
  forwarding: string;
}

export function dnsHostSteps(key: string | null, name: string | null, zone: string): DnsHostSteps {
  const www = `https://www.${zone}`;
  switch (key) {
    case "godaddy":
      return {
        open: `In GoDaddy, open My Products, find ${zone} and choose DNS.`,
        add: "Press Add New Record and fill in:",
        forwarding: `In GoDaddy's DNS page for ${zone}, open Forwarding, press Add Forwarding next to Domain, enter ${www} and choose Permanent (301).`,
      };
    case "namecheap":
      return {
        open: `In Namecheap, open Domain List, press Manage next to ${zone}, then open Advanced DNS.`,
        add: "Press Add New Record and fill in:",
        forwarding: `In Advanced DNS, add a URL Redirect Record with Host @ and value ${www}, Permanent (301).`,
      };
    case "squarespace":
      return {
        open: `In Squarespace, open Domains, choose ${zone}, then DNS.`,
        add: "Under Custom records, press Add record and fill in:",
        forwarding: `In Squarespace's Domains page for ${zone}, open Domain forwarding, add a rule from ${zone} to ${www} and choose Permanent (301).`,
      };
    case "cloudflare":
      return {
        open: `In Cloudflare, choose ${zone}, then DNS › Records.`,
        add: "Press Add record, set Proxy status to DNS only (grey cloud), and fill in:",
        forwarding: `In Cloudflare, add a Redirect Rule for ${zone} that sends visitors to ${www} with 301.`,
      };
    case "porkbun":
      return {
        open: `In Porkbun, open Domain Management and press DNS next to ${zone}.`,
        add: "In the Add a record form, fill in:",
        forwarding: `In Porkbun's Domain Management, open URL Forwarding for ${zone} and forward it to ${www}, permanent (301).`,
      };
    default: {
      const where = name === null ? `where you manage ${zone}'s DNS` : `in ${name}`;
      return {
        open: `Sign in ${where} and open the DNS records for ${zone}.`,
        add: "Add a record with:",
        forwarding: `Sign in ${where} and set up forwarding (sometimes called a redirect) from ${zone} to ${www}, permanent (301).`,
      };
    }
  }
}

/**
 * The record type to ask for at a zone's root. Cloudflare flattens a CNAME
 * there, and its form has no ALIAS; everyone else who can point a root calls
 * it ALIAS or ANAME.
 */
export function rootRecordType(key: string | null): "CNAME" | "ALIAS" {
  return key === "cloudflare" ? "CNAME" : "ALIAS";
}
