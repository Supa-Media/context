/**
 * Guests' names from the contacts on this phone (decided by Dev2, 2026-11-27): when a Tex group chat has someone in
 * it with no Context account and no name yet, the person can let the app look their number up in the phone's own
 * contacts. The gateway hands the app those numbers (`POST /tex/page/contacts {op: "numbers"}`), the match happens
 * here, and only the names it found go back (`{op: "names"}`). The contact book itself never leaves the phone.
 *
 * Never misattribute: a number two contacts share under different names is left out, and so is one that cannot be
 * read as a full international number. A name said in the chat, or a correction, still wins on the gateway.
 */

/** One contact as the phone gives it: a name and the numbers on its card. */
export interface PhoneContact {
  name?: string | null;
  numbers: readonly (string | null | undefined)[];
}

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * A contact's number as `+<digits>`, or null when it can't be read as one without guessing. Tex texts over US
 * numbers, so a bare 10-digit number, or 11 digits starting with 1, is read as +1; `00` is the international prefix.
 * Anything else without a `+` is left out rather than guessed at.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  let phone: string | null = null;
  if (plus) phone = `+${digits}`;
  else if (digits.startsWith("00")) phone = `+${digits.slice(2)}`;
  else if (digits.length === 10) phone = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) phone = `+${digits}`;
  return phone !== null && E164.test(phone) ? phone : null;
}

/** The names this phone's contacts give the asked numbers: one name per number, an ambiguous number left out. */
export function matchNames(asked: readonly string[], contacts: readonly PhoneContact[]): { phone: string; name: string }[] {
  const wanted = new Set(asked.filter((phone) => E164.test(phone)));
  const found = new Map<string, string | null>();
  for (const contact of contacts) {
    const name = typeof contact.name === "string" ? contact.name.trim().replace(/\s+/g, " ") : "";
    if (name.length === 0) continue;
    for (const raw of contact.numbers) {
      const phone = normalizePhone(raw);
      if (phone === null || !wanted.has(phone)) continue;
      const seen = found.get(phone);
      if (seen === undefined) found.set(phone, name);
      else if (seen !== null && seen.toLowerCase() !== name.toLowerCase()) found.set(phone, null);
    }
  }
  return [...found].flatMap(([phone, name]) => (name === null ? [] : [{ phone, name }]));
}

/** What a sync needs: the two gateway calls and the phone's contacts. */
export interface ContactSync {
  numbers(): Promise<string[] | null>;
  names(names: { phone: string; name: string }[]): Promise<number | null>;
  contacts(): Promise<PhoneContact[] | null>;
}

/**
 * One sync: ask which numbers have no name, read the contacts only when there are any, send back what matched.
 * Returns how many names were kept, 0 when there was nothing to do, or null when a step failed.
 */
export async function syncContactNames(sync: ContactSync): Promise<number | null> {
  const asked = await sync.numbers();
  if (asked === null) return null;
  if (asked.length === 0) return 0;
  const contacts = await sync.contacts();
  if (contacts === null) return null;
  const names = matchNames(asked, contacts);
  if (names.length === 0) return 0;
  return await sync.names(names);
}
