/**
 * The "Names from my contacts" switch (`contactNames.ts`): off until the person turns it on, kept on this device
 * because the contacts are this device's. While on, the app syncs when the Tex page opens, at most every few hours.
 */

import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TexPageSource } from "../page/texPageSource";
import { syncContactNames } from "./contactNames";
import { askContacts, contactsAvailable, readContacts } from "./deviceContacts";

const ON_KEY = "tex.contactNames.on";
const SYNCED_KEY = "tex.contactNames.syncedAt";
/** How long a sync holds before the page opening runs another. */
export const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

async function readKey(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}

async function writeKey(key: string, value: string | null): Promise<void> {
  try {
    if (value === null) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, value);
  } catch {
    // A switch that can't be stored is simply off next time.
  }
}

/** One sync through the page's source; null when the source can't, or a step failed. */
async function runSync(source: TexPageSource): Promise<number | null> {
  const { contactNumbers, contactNames } = source;
  if (!contactNumbers || !contactNames) return null;
  const kept = await syncContactNames({
    numbers: () => contactNumbers.call(source),
    names: (names) => contactNames.call(source, names),
    contacts: readContacts,
  });
  if (kept !== null) await writeKey(SYNCED_KEY, String(Date.now()));
  return kept;
}

export interface ContactNames {
  /** Whether this build and this page can offer the switch at all. */
  available: boolean;
  on: boolean;
  /** Names kept by the last sync this session, once one ran. */
  kept: number | null;
  setOn(on: boolean): void;
}

/** The switch's state, and the sync it runs. `source` is the person's own Tex page; a group page passes null. */
export function useContactNames(source: TexPageSource | null): ContactNames {
  const available = source !== null && typeof source.contactNumbers === "function" && contactsAvailable();
  const [on, setOnState] = useState(false);
  const [kept, setKept] = useState<number | null>(null);

  useEffect(() => {
    if (!available || source === null) return;
    let live = true;
    void (async () => {
      if ((await readKey(ON_KEY)) !== "1") return;
      if (live) setOnState(true);
      const last = Number(await readKey(SYNCED_KEY));
      if (Number.isFinite(last) && Date.now() - last < SYNC_EVERY_MS) return;
      const n = await runSync(source);
      if (live && n !== null) setKept(n);
    })();
    return () => {
      live = false;
    };
  }, [available, source]);

  const setOn = useCallback(
    (next: boolean) => {
      if (!available || source === null) return;
      if (!next) {
        setOnState(false);
        void writeKey(ON_KEY, null);
        void writeKey(SYNCED_KEY, null);
        return;
      }
      void (async () => {
        if (!(await askContacts())) return;
        setOnState(true);
        await writeKey(ON_KEY, "1");
        const n = await runSync(source);
        if (n !== null) setKept(n);
      })();
    },
    [available, source],
  );

  return { available, on, kept, setOn };
}
