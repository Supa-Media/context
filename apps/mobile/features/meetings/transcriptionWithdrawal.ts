import { deviceWithdrawalStore, type StrictKeyValue } from "./transcriptionWithdrawalStore";

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
 * A store that cannot be read holds the device off too: "unknown" is never
 * read as "nothing kept". It is not sent again (nothing says there was a Turn
 * off), and Allow pressed here lifts it for this run.
 *
 * **Limit:** sign-out empties the device's store, this key with it. A Turn off
 * that never reached the account and is followed by a sign-out is lost; the
 * account's answer is then whatever the server holds, which the Settings row
 * shows after the next sign-in.
 */

/** What this device holds for an account: a kept Turn off, nothing, or a store it could not read. */
export type KeptWithdrawal = "pending" | "clear" | "unknown";

const PREFIX = "context.transcription.withdrawnHere:";

let injected: StrictKeyValue | null = null;
let opened: StrictKeyValue | null = null;
/**
 * What this process has read or written, per account, so a yes needs no wait
 * after the first. An unreadable store is never cached: the next answer reads
 * again.
 */
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
export function setWithdrawalStore(store: StrictKeyValue | null): void {
  injected = store;
  known.clear();
}

function store(): StrictKeyValue {
  if (injected !== null) return injected;
  opened ??= deviceWithdrawalStore();
  return opened;
}

/** What this process already knows for this account, or `undefined` before the store is read. */
export function knownPendingWithdrawal(account: string): KeptWithdrawal | undefined {
  const cached = known.get(account);
  return cached === undefined ? undefined : cached ? "pending" : "clear";
}

export async function readPendingWithdrawal(account: string): Promise<KeptWithdrawal> {
  const cached = knownPendingWithdrawal(account);
  if (cached !== undefined) return cached;
  let pending: boolean;
  try {
    pending = (await store().get(PREFIX + account)) !== null;
  } catch {
    // Unreadable is not "nothing kept": hold off, and read again next time.
    return knownPendingWithdrawal(account) ?? "unknown";
  }
  // A Turn off or an Allow pressed while this read was in flight wins over what it found.
  if (!known.has(account)) known.set(account, pending);
  return knownPendingWithdrawal(account)!;
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
