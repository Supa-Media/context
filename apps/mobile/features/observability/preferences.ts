import { useEffect, useState } from "react";
import { openStore } from "../offline/store";

/**
 * What this device may send us, as the person set it in Settings → Privacy &
 * feedback.
 *
 * **Per device, not per account.** Storing it on the account needs a
 * control-plane field (backend work, listed for Codex in the private-beta
 * feedback note); until that lands, the switch governs the app it was turned
 * on, and the Settings copy says so. Everything defaults on, because that is
 * what the early-beta notice tells people happens.
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

export function loadPreferences(): Promise<TelemetryPreferences> {
  if (loaded === null) {
    loaded = openStore()
      .get(KEY)
      .then((raw) => {
        current = parsePreferences(raw);
        return current;
      })
      .catch(() => current);
  }
  return loaded;
}

export function preferences(): TelemetryPreferences {
  return current;
}

export async function setPreferences(
  change: Partial<TelemetryPreferences>,
): Promise<TelemetryPreferences> {
  await loadPreferences();
  const next = { ...current, ...change };
  // Written before it takes effect, so a switch never shows a setting that
  // did not save. The caller flips it back when this throws.
  await openStore().set(KEY, JSON.stringify(next));
  current = next;
  for (const listener of listeners) listener(next);
  return next;
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
  current = DEFAULT_PREFERENCES;
  loaded = null;
  listeners.clear();
}
