import {
  DEFAULT_PREFERENCES,
  loadStoredPreferences,
  setActiveAccount,
  writeStoredPreferences,
  type StoredPreferences,
  type TelemetryPreferences,
} from "./preferences";

/**
 * Keeps this device's Feedback switches in step with the account's
 * copy (`functions/telemetry.ts`), so a switch turned off anywhere holds
 * everywhere.
 *
 * The rules, in the order `reconcile` applies them:
 *
 *  - **The device copy belongs to one account.** A choice another person made
 *    on this device is never sent to the next person's account; the next
 *    person gets their own row, or the defaults if they have none.
 *  - **The later change wins.** A change made here and not yet saved is sent
 *    unless the account holds a newer one; otherwise the account's copy is
 *    applied here. Device and server clocks are compared, which is honest
 *    enough for a switch a person flips by hand.
 *  - **A choice made before the account kept one is carried up**, unless it is
 *    just the defaults, which the account already means by having no row.
 *  - **Nothing waiting is dropped.** A save that fails leaves the change
 *    pending, and the next chance (the account copy arriving or changing, or
 *    the next change) sends it.
 *
 * Every step runs one at a time, so two saves never race each other.
 */

export interface AccountPreferences extends TelemetryPreferences {
  updatedAt: number;
}

/** Save a whole choice to the account; resolves to when the account took it. */
export type PushPreferences = (value: TelemetryPreferences) => Promise<number>;

export type SyncStep =
  | { kind: "adopt"; value: AccountPreferences }
  | { kind: "push"; value: TelemetryPreferences }
  | { kind: "claim" }
  | { kind: "reset" }
  | { kind: "none" };

function switches(value: TelemetryPreferences): TelemetryPreferences {
  return {
    crashReports: value.crashReports,
    screenCounts: value.screenCounts,
    recordings: value.recordings,
  };
}

function same(a: TelemetryPreferences, b: TelemetryPreferences): boolean {
  return a.crashReports === b.crashReports && a.screenCounts === b.screenCounts && a.recordings === b.recordings;
}

export function reconcile(
  local: StoredPreferences,
  remote: AccountPreferences | null,
  me: string,
): SyncStep {
  if (local.account === me) {
    const newer = remote === null || (local.changedAt ?? 0) >= remote.updatedAt;
    if (local.pending === true && newer) return { kind: "push", value: switches(local) };
    if (remote !== null && (local.pending === true || !same(local, remote))) {
      return { kind: "adopt", value: remote };
    }
    return { kind: "none" };
  }
  if (local.account === undefined) {
    if (remote !== null) return { kind: "adopt", value: remote };
    return same(local, DEFAULT_PREFERENCES) ? { kind: "claim" } : { kind: "push", value: switches(local) };
  }
  // Another person's choices: theirs, not this account's.
  return remote !== null ? { kind: "adopt", value: remote } : { kind: "reset" };
}

let chain: Promise<void> = Promise.resolve();
let lastRemote: { me: string; remote: AccountPreferences | null } | null = null;

function enqueue(step: () => Promise<void>): Promise<void> {
  chain = chain.then(step).catch(() => {
    // A failed step leaves its change pending; the next chance retries it.
  });
  return chain;
}

async function apply(me: string, remote: AccountPreferences | null, push: PushPreferences): Promise<void> {
  const local = await loadStoredPreferences();
  const step = reconcile(local, remote, me);
  switch (step.kind) {
    case "none":
      return;
    case "adopt":
      await writeStoredPreferences({ ...switches(step.value), account: me, changedAt: step.value.updatedAt });
      return;
    case "claim":
      await writeStoredPreferences({ ...local, account: me });
      return;
    case "reset":
      await writeStoredPreferences({ ...DEFAULT_PREFERENCES, account: me });
      return;
    case "push": {
      const sentAt = local.changedAt;
      const updatedAt = await push(step.value);
      const now = await loadStoredPreferences();
      // A change made while this save was in flight is still waiting.
      if (now.changedAt !== sentAt || !same(now, step.value)) return;
      await writeStoredPreferences({ ...switches(now), account: me, changedAt: updatedAt });
      if (lastRemote?.me === me) lastRemote = { me, remote: { ...step.value, updatedAt } };
      return;
    }
  }
}

/** The account's copy has arrived or changed (null: the account has none). */
export function syncWithAccount(
  remote: AccountPreferences | null,
  me: string,
  push: PushPreferences,
): Promise<void> {
  lastRemote = { me, remote };
  return enqueue(() => apply(me, remote, push));
}

/**
 * While `me` is signed in: record changes as theirs and send each one. Returns
 * the stop for sign-out.
 */
export function startAccountSync(me: string, push: PushPreferences): () => void {
  setActiveAccount({
    account: me,
    afterChange: () => {
      // Only once the account's copy is known, so a change is weighed against
      // it rather than sent blind; until then it waits, pending.
      if (lastRemote?.me !== me) return;
      // Weighed against the account's copy as it stands when the step runs,
      // which an earlier save in the queue may have moved.
      void enqueue(() => apply(me, lastRemote?.me === me ? lastRemote.remote : null, push));
    },
  });
  return () => setActiveAccount(null);
}

/** Tests only: resolves once every queued step has run. */
export async function settledForTests(): Promise<void> {
  let seen: Promise<void> | null = null;
  while (seen !== chain) {
    seen = chain;
    await chain;
  }
}

/** Tests only. */
export function resetAccountSyncForTests(): void {
  chain = Promise.resolve();
  lastRemote = null;
}
