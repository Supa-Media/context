import type { KeyValueStore } from "../offline/memory";
import { openStore } from "../offline/store";

/**
 * A Turn off the account has not confirmed yet, kept on this device so it
 * survives a restart (`docs/decisions/meetings/transcription-consent.md`).
 *
 * Turn off stops this device at once and then tells the account. If that save
 * fails (offline, a crash) and the app is restarted, the account still says
 * yes, and without this the device would start sending again. So the Turn off
 * is written here under the account it was for, and the account's yes is not
 * trusted on this device until it is read: a pending Turn off holds the device
 * off and is sent again. It is cleared only when the account is seen saying no
 * (the Turn off arrived) or Allow is pressed here. Another account's answer
 * never touches it: the key names the account.
 *
 * Sign-out empties the device's store, and this key with it; the account's
 * answer is then whatever the server holds, and the row in Settings shows it.
 */

const PREFIX = "context.transcription.withdrawnHere:";

let injected: KeyValueStore | null = null;
let opened: KeyValueStore | null = null;
/** What this process has read or written, per account, so a yes needs no wait after the first. */
const known = new Map<string, boolean>();

let signedInAccount: string | null = null;

/** The account the signed-in layout last saw answer, so an Allow anywhere clears its Turn off. */
export function setConsentAccount(account: string | null): void {
  signedInAccount = account;
}

export function consentAccount(): string | null {
  return signedInAccount;
}

/** Tests hand in a store; `null` goes back to the device's own. */
export function setWithdrawalStore(store: KeyValueStore | null): void {
  injected = store;
  known.clear();
}

function store(): KeyValueStore {
  if (injected !== null) return injected;
  opened ??= openStore();
  return opened;
}

/** Whether this process already knows the answer for this account, and what it is. */
export function knownPendingWithdrawal(account: string): boolean | undefined {
  return known.get(account);
}

export async function readPendingWithdrawal(account: string): Promise<boolean> {
  const cached = known.get(account);
  if (cached !== undefined) return cached;
  let pending = false;
  try {
    pending = (await store().get(PREFIX + account)) !== null;
  } catch {
    // Unreadable is no evidence of a Turn off; the account's own answer stands.
  }
  // A Turn off pressed while this read was in flight wins over what it found.
  if (!known.has(account)) known.set(account, pending);
  return known.get(account)!;
}

export async function rememberWithdrawal(account: string): Promise<void> {
  known.set(account, true);
  try {
    await store().set(PREFIX + account, String(Date.now()));
  } catch {
    // The in-process latch still holds; only a restart could lose it.
  }
}

export async function clearWithdrawal(account: string): Promise<void> {
  known.set(account, false);
  try {
    await store().remove(PREFIX + account);
  } catch {
    // A key left behind costs one more withdrawal retry, which is harmless.
  }
}
