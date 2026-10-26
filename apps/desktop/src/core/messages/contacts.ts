/**
 * Names for the numbers in `chat.db`, from the Mac's own Contacts.
 *
 * `chat.db` knows a sender as `+15550100` or an email address. A person asks
 * Tex about "Ada", so the backup carries, for each handle that appears in a
 * conversation, the name the Mac's Contacts gives it. **Only those**: the
 * address book itself is never copied, and a contact who has never texted
 * this Mac is never sent anywhere.
 *
 * Contacts keeps one SQLite database per account under
 * `~/Library/Application Support/AddressBook` (the top level and each
 * `Sources/<id>/`). They are read with the same `sqlite3 -readonly` as
 * `chat.db`, and only at paths `isAllowedAddressBookPath` accepts.
 */

import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { BACKUP_VERSION } from "@context/communications/backup";
import type { PersonRecord } from "./records.ts";

export const ADDRESS_BOOK_FILE = "AddressBook-v22.abcddb";

export function addressBookRoot(): string {
  return join(homedir(), "Library", "Application Support", "AddressBook");
}

/** The root database or one under `Sources/<one folder>/`, and nothing else. */
export function isAllowedAddressBookPath(candidate: unknown, root: string = addressBookRoot()): candidate is string {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const rel = relative(resolve(root), resolve(candidate));
  if (rel.startsWith("..") || rel === "") return false;
  const parts = rel.split(sep);
  if (parts.length === 1) return parts[0] === ADDRESS_BOOK_FILE;
  return parts.length === 3 && parts[0] === "Sources" && /^[A-Za-z0-9-]{1,64}$/.test(parts[1] ?? "") && parts[2] === ADDRESS_BOOK_FILE;
}

/** Each person's phone numbers. */
export function selectPhoneNamesSql(): string {
  return [
    "SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZNICKNAME AS nickname, r.ZORGANIZATION AS organization, p.ZFULLNUMBER AS address",
    "FROM ZABCDPHONENUMBER AS p JOIN ZABCDRECORD AS r ON r.Z_PK = p.ZOWNER",
    "WHERE p.ZFULLNUMBER IS NOT NULL;",
  ].join("\n");
}

/** Each person's email addresses. */
export function selectEmailNamesSql(): string {
  return [
    "SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, r.ZNICKNAME AS nickname, r.ZORGANIZATION AS organization, e.ZADDRESS AS address",
    "FROM ZABCDEMAILADDRESS AS e JOIN ZABCDRECORD AS r ON r.Z_PK = e.ZOWNER",
    "WHERE e.ZADDRESS IS NOT NULL;",
  ].join("\n");
}

export interface AddressBookRow {
  first: string | null;
  last: string | null;
  nickname: string | null;
  organization: string | null;
  address: string | null;
}

/**
 * The key two spellings of one address share. An email, lowercased. A phone
 * number, its digits, and only the last ten when there are more, so
 * `+1 (555) 010-0100` in Contacts meets `+15550100100` in `chat.db`. Fewer
 * than seven digits is a short code, which no person is; it matches nothing.
 */
export function addressKey(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function nameOf(row: AddressBookRow): string | null {
  const full = [row.first, row.last].map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
  const name = full || (row.nickname ?? "").trim() || (row.organization ?? "").trim();
  return name || null;
}

/**
 * One person record per handle that has a name. A handle two contacts claim
 * with different names is left unnamed rather than guessed: naming the wrong
 * person in a search is worse than naming nobody.
 */
export function personRecords(handles: Iterable<string>, rows: readonly AddressBookRow[]): PersonRecord[] {
  const names = new Map<string, string | null>();
  for (const row of rows) {
    if (typeof row.address !== "string") continue;
    const key = addressKey(row.address);
    const name = nameOf(row);
    if (key === null || name === null) continue;
    const seen = names.get(key);
    if (seen === undefined) names.set(key, name);
    else if (seen !== null && seen !== name) names.set(key, null);
  }
  const records: PersonRecord[] = [];
  for (const handle of new Set(handles)) {
    const key = addressKey(handle);
    const name = key === null ? null : names.get(key) ?? null;
    if (name) records.push({ v: BACKUP_VERSION, kind: "person", handle, name });
  }
  return records.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));
}
