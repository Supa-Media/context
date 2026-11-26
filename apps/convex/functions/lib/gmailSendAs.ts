/**
 * A connected Gmail's "Send mail as" addresses (Dev2, 2026-11-26: a work
 * mailbox, seyi@…, sends as the practice's reception@… group address).
 *
 * Read from Gmail's own `users.settings.sendAs.list`, which the Gmail read
 * scope every connection already holds allows; nothing new is asked of the
 * person. Only an address Gmail itself accepted (`verificationStatus:
 * "accepted"`, verified by Gmail or by the domain's admin) is kept: Gmail
 * rewrites the From of any other one to the mailbox's own address, so the
 * person would be shown one sender and the email would go from another.
 * The mailbox's own address (`isPrimary`) is the row's `address` already.
 *
 * Kept on the connection row (`gmailSendAs`), addresses and Gmail's display
 * name only: a setting of the account, like the address, never a word of mail.
 */

/** Most send-as addresses kept for one mailbox; Gmail allows about a hundred. */
export const MAX_SEND_AS = 30;
/** How long a list is trusted before the sweep reads it again (`functions/gmailSendAs.ts`). */
export const SEND_AS_FRESH_MS = 6 * 60 * 60 * 1000;

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** A display name that can go in a From header: printable, no quote, backslash or angle bracket to break out of it. */
const NAME_UNSAFE = /[\u0000-\u001f\u007f"\\<>\u202a-\u202e\u2066-\u2069]/g;

export interface SendAsAlias {
  address: string;
  name?: string;
}

/** The accepted, non-primary send-as addresses in Gmail's answer, lowercased, deduplicated, minus the mailbox's own. */
export function sendAsAliasesOf(answer: unknown, ownAddress: string): SendAsAlias[] {
  const list = (answer as { sendAs?: unknown } | null)?.sendAs;
  if (!Array.isArray(list)) return [];
  const own = ownAddress.toLowerCase();
  const seen = new Set<string>([own]);
  const out: SendAsAlias[] = [];
  for (const entry of list) {
    const raw = entry as { sendAsEmail?: unknown; displayName?: unknown; isPrimary?: unknown; verificationStatus?: unknown } | null;
    if (raw === null || typeof raw !== "object" || raw.isPrimary === true) continue;
    if (raw.verificationStatus !== "accepted") continue;
    const address = typeof raw.sendAsEmail === "string" ? raw.sendAsEmail.trim().toLowerCase() : "";
    if (address.length > 254 || !ADDRESS.test(address) || seen.has(address)) continue;
    seen.add(address);
    const name = typeof raw.displayName === "string" ? raw.displayName.replace(NAME_UNSAFE, "").replace(/\s+/g, " ").trim().slice(0, 100) : "";
    out.push(name === "" ? { address } : { address, name });
    if (out.length >= MAX_SEND_AS) break;
  }
  return out;
}

/** Every address a connection sends as: its own first, then its accepted send-as ones. */
export function sendingAddressesOf(row: { address: string; gmailSendAs?: { aliases: SendAsAlias[] } }): string[] {
  return [row.address.toLowerCase(), ...(row.gmailSendAs?.aliases ?? []).map((alias) => alias.address)];
}

/** The send-as entry a From names on this connection, or null when it is the mailbox's own address or none of its. */
export function aliasOf(row: { address: string; gmailSendAs?: { aliases: SendAsAlias[] } }, from: string): SendAsAlias | null {
  if (row.address.toLowerCase() === from) return null;
  return row.gmailSendAs?.aliases.find((alias) => alias.address === from) ?? null;
}
