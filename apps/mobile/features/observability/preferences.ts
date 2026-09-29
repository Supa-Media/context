import { useEffect, useState } from "react";
import { openStore } from "../offline/store";

/**
 * What this device may send us, as the person set it in Settings → Privacy &
 * feedback.
 *
 * **Kept on the device and on the account.** The device copy is what applies
 * before sign-in and offline; `accountPreferences.ts` keeps it in step with
 * the account's copy (`functions/telemetry.ts`), so a switch turned off on a
 * phone holds in the browser too. The stored record carries which account it
 * belongs to and whether a change is still waiting to reach it. Everything
 * defaults on, because that is what the early-beta notice tells people
 * happens.
 *
 * Feedback reports are not governed by these: sending one is its own explicit
 * act, with its own list of what goes.
 */
export interface TelemetryPreferences {
  /** Sentry error and crash reports. */
  crashReports: boolean;
  /** PostHog screen views. Off also stops recordings, which PostHog makes. */
  screenCounts: boolean;
  /** PostHog's masked web session replay. */
  recordings: boolean;
}

export const DEFAULT_PREFERENCES: TelemetryPreferences = {
  crashReports: true,
  screenCounts: true,
  recordings: true,
};

const KEY = "context.telemetry.preferences.v1";

/**
 * The device copy, with where it stands against the account.
 *
 * `account` is the account these switches belong to — absent for a choice
 * made before the account kept one. `pending` is a change made here that the
 * account has not taken yet, and `changedAt` is when it was made, so the
 * later of two devices' changes wins.
 */
export interface StoredPreferences extends TelemetryPreferences {
  account?: string;
  changedAt?: number;
  pending?: boolean;
}

/** An account id as the control plane writes one: short, plain characters. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

let stored: StoredPreferences = DEFAULT_PREFERENCES;
let current: TelemetryPreferences = DEFAULT_PREFERENCES;
let loaded: Promise<TelemetryPreferences> | null = null;
const listeners = new Set<(value: TelemetryPreferences) => void>();

/** Anything unreadable falls back to the default for that one switch. */
export function parsePreferences(raw: string | null): TelemetryPreferences {
  if (raw === null) return DEFAULT_PREFERENCES;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof TelemetryPreferences, unknown>>;
    const pick = (key: keyof TelemetryPreferences) =>
      typeof value[key] === "boolean" ? (value[key] as boolean) : DEFAULT_PREFERENCES[key];
    return {
      crashReports: pick("crashReports"),
      screenCounts: pick("screenCounts"),
      recordings: pick("recordings"),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

/** The stored record: the switches, plus the sync fields only if well-formed. */
export function parseStored(raw: string | null): StoredPreferences {
  const switches = parsePreferences(raw);
  if (raw === null) return switches;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const next: StoredPreferences = { ...switches };
    if (typeof value.account === "string" && ACCOUNT_PATTERN.test(value.account)) next.account = value.account;
    if (typeof value.changedAt === "number" && Number.isFinite(value.changedAt)) next.changedAt = value.changedAt;
    if (value.pending === true) next.pending = true;
    return next;
  } catch {
    return switches;
  }
}

function switchesOf(value: TelemetryPreferences): TelemetryPreferences {
  return {
    crashReports: value.crashReports,
    screenCounts: value.screenCounts,
    recordings: value.recordings,
  };
}

export function loadPreferences(): Promise<TelemetryPreferences> {
  if (loaded === null) {
    loaded = openStore()
      .get(KEY)
      .then((raw) => {
        stored = parseStored(raw);
        current = switchesOf(stored);
        return current;
      })
      .catch(() => current);
  }
  return loaded;
}

/** The stored record, once read. */
export async function loadStoredPreferences(): Promise<StoredPreferences> {
  await loadPreferences();
  return stored;
}

/**
 * Replace the stored record, then apply it. Written before it takes effect,
 * so a switch never shows a setting that did not save.
 */
export async function writeStoredPreferences(next: StoredPreferences): Promise<void> {
  await loadPreferences();
  await openStore().set(KEY, JSON.stringify(next));
  stored = next;
  const switches = switchesOf(next);
  const changed =
    switches.crashReports !== current.crashReports ||
    switches.screenCounts !== current.screenCounts ||
    switches.recordings !== current.recordings;
  current = switches;
  if (changed) for (const listener of listeners) listener(switches);
}

type ChangeHook = (next: StoredPreferences) => void;
let activeAccount: { account: string; afterChange: ChangeHook } | null = null;

/**
 * `accountPreferences.ts` only: who is signed in, so a change made now is
 * recorded as theirs, and what to call once it is saved here. `null` on
 * sign-out.
 */
export function setActiveAccount(value: { account: string; afterChange: ChangeHook } | null): void {
  activeAccount = value;
}

export function preferences(): TelemetryPreferences {
  return current;
}

export async function setPreferences(
  change: Partial<TelemetryPreferences>,
): Promise<TelemetryPreferences> {
  await loadPreferences();
  const next: StoredPreferences = {
    ...stored,
    ...switchesOf({ ...current, ...change }),
    // A change made while signed in belongs to that account, whatever the
    // record said before; signed out, it stays with whoever it was.
    account: activeAccount?.account ?? stored.account,
    changedAt: Date.now(),
    pending: true,
  };
  // The caller flips the switch back when this throws.
  await writeStoredPreferences(next);
  activeAccount?.afterChange(next);
  return current;
}

export function onPreferencesChange(listener: (value: TelemetryPreferences) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The switches as they stand, and `null` until the stored value has been read. */
export function useTelemetryPreferences(): TelemetryPreferences | null {
  const [value, setValue] = useState<TelemetryPreferences | null>(null);
  useEffect(() => {
    let live = true;
    void loadPreferences().then((read) => {
      if (live) setValue(read);
    });
    const stop = onPreferencesChange(setValue);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return value;
}

/** Tests only. */
export function resetPreferencesForTests(): void {
  stored = DEFAULT_PREFERENCES;
  current = DEFAULT_PREFERENCES;
  activeAccount = null;
  loaded = null;
  listeners.clear();
}
