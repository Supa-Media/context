/**
 * The phone's contacts, behind the native gate (`native-deps.json` lists `expo-contacts` as `gated`): an app built
 * before the contacts module shipped gets the same JS over the air, finds no `ExpoContacts`, and draws no switch.
 * The web has no contacts, so `deviceContacts.web.ts` answers unavailable there.
 */

import { requireOptionalNativeModule } from "expo-modules-core";
import type { PhoneContact } from "./contactNames";

/** Whether this build has the contacts module at all. */
export function contactsAvailable(): boolean {
  try {
    return requireOptionalNativeModule("ExpoContacts") !== null;
  } catch {
    return false;
  }
}

/** Ask for the contacts permission (the system's own sheet); true when granted. */
export async function askContacts(): Promise<boolean> {
  if (!contactsAvailable()) return false;
  try {
    const Contacts = await import("expo-contacts");
    const { status } = await Contacts.requestPermissionsAsync();
    return status === "granted";
  } catch {
    return false;
  }
}

/** Every contact's name and numbers, read on the phone only; null when not allowed or unreadable. */
export async function readContacts(): Promise<PhoneContact[] | null> {
  if (!contactsAvailable()) return null;
  try {
    const Contacts = await import("expo-contacts");
    const { status } = await Contacts.getPermissionsAsync();
    if (status !== "granted") return null;
    const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers] });
    return data.map((contact) => ({
      name: contact.name,
      numbers: (contact.phoneNumbers ?? []).map((entry) => entry.number ?? entry.digits ?? null),
    }));
  } catch {
    return null;
  }
}
