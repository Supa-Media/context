/**
 * What a customer may type as their domain, and the one form we store it in.
 *
 * Pure: no Convex, no fetch. The hostname is the key a request is routed by,
 * so every copy of it — the row, the provider registration, the lookup the
 * router makes — has to be this function's output and nothing else. Two
 * spellings of one name reaching two rows is how a domain gets claimed twice.
 */

/** The longest hostname DNS can carry, in its ASCII form. */
const MAX_HOSTNAME = 253;

/** One DNS label in its ASCII (punycode) form. */
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A top-level label: letters, or an IDN's `xn--` form. Never all digits. */
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Names no customer may bring, because they are ours or nobody's.
 *
 * `context.lc` and everything under it is the product itself: a customer
 * "connecting" `mcp.context.lc` must be refused before any provider call, not
 * after one. The rest are suffixes that are never a domain somebody owns.
 */
const REFUSED_SUFFIXES = [
  "context.lc",
  "localhost",
  "local",
  "internal",
  "invalid",
  "test",
  "example",
  "arpa",
  "onion",
];

export type HostnameRejection =
  | "EMPTY"
  | "NOT_A_DOMAIN"
  | "TOO_LONG"
  | "IP_ADDRESS"
  | "PLATFORM_DOMAIN";

export type NormalizedHostname =
  | { ok: true; hostname: string; apex: boolean }
  | { ok: false; reason: HostnameRejection };

/**
 * Turn what somebody typed into the stored form, or say why it is not one.
 *
 * Forgiving about what people paste — `https://Docs.Acme.com/intake`, a
 * trailing dot, surrounding spaces — and strict about the result: lowercase
 * ASCII, IDNs as punycode (the WHATWG URL parser does the conversion, so it is
 * the same one browsers use), at least two labels, no port, no IP literal.
 *
 * `apex` is a guess from the label count, and only ever used to choose which
 * DNS instructions to show. It is wrong for `acme.co.uk`, which is why the
 * screen shows both forms of the record's name rather than branching on it.
 */
export function normalizeHostname(raw: string): NormalizedHostname {
  if (typeof raw !== "string") return { ok: false, reason: "EMPTY" };
  let text = raw.trim();
  if (text.length === 0) return { ok: false, reason: "EMPTY" };

  // Somebody pasted a URL. Keep only the host part; a path or query is never
  // part of the name we register.
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  text = text.split(/[/?#]/, 1)[0] ?? "";
  if (text.includes("@") || text.includes(":") || text.includes("*")) {
    // Credentials, a port, an IPv6 literal or a wildcard. None is a domain a
    // person connects, and a wildcard would claim names they never typed.
    return { ok: false, reason: "NOT_A_DOMAIN" };
  }
  text = text.replace(/\.$/, "");
  if (text.length === 0) return { ok: false, reason: "EMPTY" };

  let ascii: string;
  try {
    ascii = new URL(`https://${text}/`).hostname;
  } catch {
    return { ok: false, reason: "NOT_A_DOMAIN" };
  }
  ascii = ascii.toLowerCase().replace(/\.$/, "");

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ascii)) return { ok: false, reason: "IP_ADDRESS" };
  if (ascii.length > MAX_HOSTNAME) return { ok: false, reason: "TOO_LONG" };

  const labels = ascii.split(".");
  if (labels.length < 2) return { ok: false, reason: "NOT_A_DOMAIN" };
  if (!labels.every((label) => LABEL_RE.test(label))) {
    return { ok: false, reason: "NOT_A_DOMAIN" };
  }
  const tld = labels[labels.length - 1] ?? "";
  if (!TLD_RE.test(tld)) return { ok: false, reason: "NOT_A_DOMAIN" };

  if (REFUSED_SUFFIXES.some((suffix) => ascii === suffix || ascii.endsWith(`.${suffix}`))) {
    return { ok: false, reason: "PLATFORM_DOMAIN" };
  }

  return { ok: true, hostname: ascii, apex: labels.length === 2 };
}

/** Our sentence for each rejection. Shown under the field, verbatim. */
export function describeHostnameRejection(reason: HostnameRejection): string {
  switch (reason) {
    case "EMPTY":
      return "Enter a domain, like docs.example.com.";
    case "TOO_LONG":
      return "That domain is too long.";
    case "IP_ADDRESS":
      return "Enter a domain name rather than an IP address.";
    case "PLATFORM_DOMAIN":
      return "That domain can't be connected. Use one you own.";
    case "NOT_A_DOMAIN":
      return "That doesn't look like a domain. Try something like docs.example.com.";
  }
}

/**
 * The record name as a DNS provider's form expects it, relative to the zone.
 *
 * Most providers want `docs` for `docs.acme.com` and `@` for the apex; showing
 * the full name makes some of them create `docs.acme.com.acme.com`. We cannot
 * know where the customer's zone starts (`acme.co.uk`), so this assumes the
 * registrable domain is the last two labels, and the screen shows the full name
 * beside it for the cases where that is wrong.
 */
export function relativeRecordName(fullName: string, hostname: string): string {
  const labels = hostname.split(".");
  const zone = labels.slice(-2).join(".");
  if (fullName === zone) return "@";
  if (fullName.endsWith(`.${zone}`)) return fullName.slice(0, -(zone.length + 1));
  return fullName;
}
