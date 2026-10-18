/**
 * Proving a customer owns the domain they typed, with a record only they can
 * publish.
 *
 * ## Why a CNAME is not proof
 *
 * Cloudflare activates a custom hostname as soon as traffic for it arrives at
 * our zone, which a CNAME to our target achieves. That is proof somebody once
 * pointed the name at Context — not proof that the workspace claiming it now is
 * theirs. The textbook takeover: an old customer removes `docs.acme.com` from
 * their workspace and forgets the CNAME; anybody who types `docs.acme.com` next
 * would verify instantly and serve their own pages at Acme's address.
 *
 * So a domain goes live only when a TXT record carrying a value minted for
 * **this** claim is published under the name. A leftover CNAME cannot carry a
 * value that did not exist when it was written.
 *
 * ## How we look
 *
 * DNS over HTTPS against a public resolver, because an action has `fetch` and
 * no resolver. Resolvers cache, so a record added a minute ago may take a few
 * more to appear; the checker retries, and "not yet" is a wait, not a failure.
 */

/** The label the ownership record lives under, prefixed to the hostname. */
export const OWNERSHIP_LABEL = "_context";

/** What the record's value starts with, so a stray TXT is never mistaken for ours. */
export const OWNERSHIP_PREFIX = "context-verification=";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5_000;

export function ownershipRecordName(hostname: string): string {
  return `${OWNERSHIP_LABEL}.${hostname}`;
}

export function ownershipRecordValue(token: string): string {
  return `${OWNERSHIP_PREFIX}${token}`;
}

/** A fresh, unguessable claim value: 32 hex characters. */
export function mintOwnershipToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface DohRecord {
  /** The owner name, without its trailing dot. */
  name: string;
  type: number;
  data: string;
}

/** Record types by number, as DNS-over-HTTPS answers name them. */
export const RR = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28, CAA: 257 } as const;

/**
 * One question to the public resolver: the answer and authority sections, or
 * `null` when it could not be asked. An empty answer is an answer.
 */
export async function dohQuery(
  name: string,
  type: keyof typeof RR,
): Promise<{ answer: DohRecord[]; authority: DohRecord[] } | null> {
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(DOH_TIMEOUT_MS)
      : undefined;
  try {
    const response = await globalThis.fetch(
      `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`,
      {
        headers: { Accept: "application/dns-json" },
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { Answer?: unknown[]; Authority?: unknown[] } | null;
    return { answer: records(body?.Answer), authority: records(body?.Authority) };
  } catch {
    return null;
  }
}

function records(raw: unknown[] | undefined): DohRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DohRecord[] = [];
  for (const item of raw) {
    const record = item as { name?: unknown; type?: unknown; data?: unknown };
    if (typeof record.type !== "number" || typeof record.data !== "string") continue;
    out.push({
      name: typeof record.name === "string" ? record.name.toLowerCase().replace(/\.$/, "") : "",
      type: record.type,
      data: record.data,
    });
  }
  return out;
}

/**
 * Every TXT string published at `name`, or `null` when the resolver could not
 * be asked. An empty list is an answer — nothing is there yet.
 */
export async function lookupTxt(name: string): Promise<string[] | null> {
  const result = await dohQuery(name, "TXT");
  if (result === null) return null;
  return result.answer.filter((answer) => answer.type === RR.TXT).map((answer) => unquoteTxt(answer.data));
}

/**
 * A TXT answer as the resolver writes it — one or more quoted strings — joined
 * back into the value the customer pasted.
 */
export function unquoteTxt(data: string): string {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g);
  if (parts === null) return data.trim();
  return parts.map((part) => part.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
}

/** Is the ownership record for this claim published? `null` = could not ask. */
export async function ownershipPublished(
  hostname: string,
  token: string,
): Promise<boolean | null> {
  const values = await lookupTxt(ownershipRecordName(hostname));
  if (values === null) return null;
  const expected = ownershipRecordValue(token);
  return values.some((value) => value.trim() === expected);
}
