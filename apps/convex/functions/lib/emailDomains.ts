import { normalizeEmail } from "@context/shared";

/**
 * Email domains, for opening a workspace to everyone at one (Dev2,
 * 2026-10-09). A domain is an organization only when one organization hands
 * out its addresses: anybody can get a Gmail address, so opening a workspace
 * to `gmail.com` would open it to the world, which `team` never means
 * (non-negotiable #5). These are refused outright.
 */
const PERSONAL_MAIL = new Set([
  "aol.com",
  "duck.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "googlemail.com",
  "hey.com",
  "hotmail.co.uk",
  "hotmail.com",
  "hotmail.fr",
  "icloud.com",
  "live.com",
  "mail.com",
  "mail.ru",
  "mac.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "rocketmail.com",
  "tutanota.com",
  "web.de",
  "yahoo.co.uk",
  "yahoo.com",
  "yahoo.fr",
  "yandex.com",
  "yandex.ru",
  "ymail.com",
  "zoho.com",
]);

/** The domain of an address, lower case, or null for anything that is not one. */
export function domainOf(email: string): string | null {
  const normalized = normalizeEmail(email);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return null;
  return normalizeDomain(normalized.slice(at + 1));
}

/**
 * A domain as typed (`@PublicWorship.org`, `publicworship.org.`), or null
 * when it is not a plausible one: letters, digits and hyphens in dot-separated
 * labels, at least two of them.
 */
export function normalizeDomain(raw: string): string | null {
  const domain = raw.trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "");
  if (domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2) return null;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  return labels.every((part) => label.test(part)) ? domain : null;
}

/** Whether anybody can get an address at `domain`. */
export function isPersonalMailDomain(domain: string): boolean {
  return PERSONAL_MAIL.has(domain);
}
