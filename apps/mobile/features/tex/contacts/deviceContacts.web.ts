/** The web has no phone contacts: no switch is drawn there (`deviceContacts.ts`). */

import type { PhoneContact } from "./contactNames";

export function contactsAvailable(): boolean {
  return false;
}

export async function askContacts(): Promise<boolean> {
  return false;
}

export async function readContacts(): Promise<PhoneContact[] | null> {
  return null;
}
