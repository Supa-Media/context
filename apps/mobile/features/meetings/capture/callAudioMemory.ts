/**
 * What this browser has done when asked for a call's audio, remembered here.
 *
 * ## Why this browser and not the account
 *
 * Whether a share hands back sound is a fact about one browser on one machine:
 * Chrome on a Mac from 141 does, Arc on the same Mac may not, and the same
 * account on Windows always can. Kept on the account it would stop Chrome
 * asking because Arc failed. So it lives in this browser's own storage, and a
 * browser with no storage (a private window, blocked site data) behaves as if
 * nothing had happened yet: it asks, which is today's behaviour.
 *
 * ## What it is for
 *
 *  - `worked`: a share has carried sound here at least once. Until it has,
 *    pressing Record shows a short note first that says what the browser's
 *    picker will ask (`CallAudioPrimer`); after it has, Record goes straight
 *    to the picker.
 *  - `silent`: shares in a row that came back with no sound (cancelled,
 *    switch left off, or a browser that cannot). After `STOP_ASKING_AFTER` of
 *    them a meeting starts with the microphone only and says so, with a link
 *    that asks again. The picker every meeting, failing the same way every
 *    meeting, was the complaint (Supa Leadership Weekly, 2026-10-17).
 *
 * The call's audio is still on by default (Dev2, 2026-10-01): nothing here is
 * a setting, and one share that works resets it.
 */

/** Shares in a row with no sound before a meeting stops asking. */
export const STOP_ASKING_AFTER = 2;

export interface CallAudioMemory {
  worked: boolean;
  silent: number;
}

const KEY = "context.meetings.callAudio.v1";
const EMPTY: CallAudioMemory = Object.freeze({ worked: false, silent: 0 });

interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let override: KeyValue | null | undefined;

/** Tests hand in their own store; `undefined` puts the browser's back. */
export function setCallAudioStorage(store: KeyValue | null | undefined): void {
  override = store;
}

function storage(): KeyValue | null {
  if (override !== undefined) return override;
  try {
    const store = (globalThis as { localStorage?: KeyValue }).localStorage;
    return store ?? null;
  } catch {
    // Reading `localStorage` itself throws where site data is blocked.
    return null;
  }
}

export function readCallAudioMemory(): CallAudioMemory {
  try {
    const raw = storage()?.getItem(KEY);
    if (raw == null) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<CallAudioMemory>;
    return {
      worked: parsed.worked === true,
      silent:
        typeof parsed.silent === "number" && Number.isFinite(parsed.silent) && parsed.silent > 0
          ? Math.floor(parsed.silent)
          : 0,
    };
  } catch {
    return EMPTY;
  }
}

function write(memory: CallAudioMemory): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Full or blocked storage costs the memory, never the meeting.
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A screen's bug is not a reason to lose the write.
    }
  }
}

/** A share came back: with sound (`true`) or without (`false`). */
export function noteCallAudioShare(carriedSound: boolean): void {
  const now = readCallAudioMemory();
  write(carriedSound ? { worked: true, silent: 0 } : { worked: now.worked, silent: now.silent + 1 });
}

/** The next meeting asks again. Settings' "Try again" with no meeting running. */
export function askForCallAudioAgain(): void {
  write({ ...readCallAudioMemory(), silent: 0 });
}

/** True when this browser has failed enough times that a meeting stops asking. */
export function callAudioGivenUp(memory: CallAudioMemory = readCallAudioMemory()): boolean {
  return memory.silent >= STOP_ASKING_AFTER;
}

const listeners = new Set<() => void>();

/** Told after every write, so a settings row can redraw. Returns an unsubscribe. */
export function onCallAudioMemory(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
