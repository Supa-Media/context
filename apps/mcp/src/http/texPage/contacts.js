/**
 * `POST /tex/page/contacts`: guests' names from the contacts on a member's own phone (decided by Dev2, 2026-11-27).
 *
 *  - `{ handle, op: "numbers" }` → `{ numbers }`: the numbers of the people with no account in this person's Tex group
 *    chats that the chat has no name for yet, so the Context app can look them up on the phone.
 *  - `{ handle, op: "names", names: [{ phone, name }] }` → `{ kept }`: the names the phone found. Each is kept on
 *    every chat of this person's where that number is a guest with no name yet (`groupGuestNames.js`, `by: "contacts"`),
 *    so a name somebody said in the chat, or a later correction, always wins.
 *
 * The contact book never leaves the phone: the app sends only names for numbers this route gave it, and anything
 * else is dropped here. Which chats are the person's is read by the control plane from the console grant
 * (`functions/texPage.ts` `guestsFor`); nothing in the body says whose chats they are. Each chat's guests and their
 * numbers are read from the chat's own ledger (`numbers` entries, `groupGuestNames.js` `keepGuestNumbers`): the
 * control plane never keeps a number. Nothing is logged but counts.
 */

import { guestNameEntry, readGuestNames, readGuestNumbers } from "../../../../../packages/tex/gateway/agent/groupGuestNames.js";
import { cleanName } from "../../../../../packages/shared/src/personNameText.cjs";
import { PageRefusal } from "./page.js";

export const TEX_CONTACTS_PATH = "/tex/page/contacts";
const PHONE = /^\+[1-9]\d{6,14}$/;
const KEY = /^[0-9a-f]{64}$/;
/** At most this many numbers go out, or names come back, in one call: far more than a person's chats hold. */
const MAX_NUMBERS = 400;

/** The person's group chats, as the control plane reads them from the grant; a refusal for anything else. */
async function guestChats(controlPlane, session) {
  const answer = await controlPlane.texPageGuests(session.accessToken).catch(() => null);
  if (answer?.status !== "ok" || !Array.isArray(answer.chats)) throw new PageRefusal(403, "refused", "The chats could not be read.");
  return answer.chats.filter((chat) => KEY.test(chat?.key ?? ""));
}

/** Each chat with its guests that have no kept name yet: `[{ key, ledger, unnamed: [{ phone, label }] }]`. */
async function unnamedOf(ledgerOf, chats) {
  return await Promise.all(
    chats.map(async (chat) => {
      const ledger = ledgerOf(chat.key);
      const [numbers, names] = await Promise.all([readGuestNumbers(ledger, chat.key), readGuestNames(ledger, chat.key)]);
      const named = new Set(names.map((entry) => entry.guest));
      const unnamed = (numbers ?? []).filter((guest) => PHONE.test(guest.phone) && !named.has(guest.guest)).map(({ guest, phone }) => ({ phone, label: guest }));
      return { key: chat.key, ledger, unnamed };
    }),
  );
}

/** `ledgerOf(key)` is that chat's ledger (`ledgerFor(env, {chat: key})`), or null. */
export async function handleTexContacts(ledgerOf, controlPlane, session, body) {
  const chats = await unnamedOf(ledgerOf, await guestChats(controlPlane, session));
  if (body?.op === "numbers") {
    const numbers = [...new Set(chats.flatMap((chat) => chat.unnamed.map((guest) => guest.phone)))].slice(0, MAX_NUMBERS);
    console.log(JSON.stringify({ event: "tex_contacts", op: "numbers", chats: chats.length, numbers: numbers.length }));
    return { numbers };
  }
  if (body?.op !== "names" || !Array.isArray(body.names)) throw new PageRefusal(400, "invalid_request", "Say op numbers, or op names with names.");
  const found = new Map();
  for (const entry of body.names.slice(0, MAX_NUMBERS)) {
    const name = cleanName(entry?.name);
    if (PHONE.test(entry?.phone ?? "") && name !== "") found.set(entry.phone, name);
  }
  let kept = 0;
  for (const chat of chats) {
    const entries = chat.unnamed.filter((guest) => found.has(guest.phone)).map((guest) => guestNameEntry(guest.label, found.get(guest.phone), { by: "contacts" }));
    if (entries.length === 0 || typeof chat.ledger?.append !== "function") continue;
    try {
      await chat.ledger.append(chat.key, entries);
      kept += entries.length;
    } catch (error) {
      console.log(JSON.stringify({ event: "tex_contacts_unkept", reason: String(error?.name ?? "error").slice(0, 40) }));
    }
  }
  console.log(JSON.stringify({ event: "tex_contacts", op: "names", chats: chats.length, offered: found.size, kept }));
  return { kept };
}
