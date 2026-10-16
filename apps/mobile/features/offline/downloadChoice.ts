import { useSyncExternalStore } from "react";
import { folderRole } from "@context/shared/src/folderRoles.cjs";
import { keyFor, parseKey } from "./keys";
import type { KeyValueStore } from "./memory";

/**
 * What this device downloads, per workspace (decided by the owner,
 * 2026-10-16: "auto downloading everything not in archive", and "allow them
 * per workspace to just choose not to download it, to keep it online only").
 *
 * Two rules, both about which note bodies the mirror keeps:
 *
 *  - **Archive stays online.** A note under a top-level folder playing the
 *    archive role (`folderRole`, so `4-archive` and `9-archive` alike) is
 *    listed — its name is in the tree offline too — but its body is never
 *    downloaded, and a body an older build downloaded is dropped. Trash is not
 *    in the manifest at all (it is plumbing under `.context/`).
 *  - **A workspace can be online only.** Its tree is still listed (cheap, and
 *    what draws the sidebar offline), but no body is kept.
 *
 * The choice is this device's, not the account's: it is about this device's
 * storage, the way a phone short on space and a laptop that is not are two
 * different answers. It lives under the offline namespace as the `download`
 * kind, so signing out and losing a workspace forget it with everything else,
 * and `sweep` never ages it out (`cache.ts`).
 */

const ONLINE_ONLY = "online-only";

/** Whether a note at this path is one the mirror downloads at all. */
export function downloadsPath(path: string): boolean {
  const top = path.split("/", 1)[0] ?? "";
  if (top === path) return true; // a note at the root
  return folderRole(top) !== "archive";
}

/* --------------------------------- the store ------------------------------ */

let onlineOnly: ReadonlySet<string> = new Set();
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(next: ReadonlySet<string>): void {
  onlineOnly = next;
  for (const listener of listeners) listener();
}

/** Read every workspace's choice once per session. Safe to call repeatedly. */
export function loadDownloadChoices(kv: KeyValueStore): Promise<void> {
  if (loaded !== null) return loaded;
  loaded = (async () => {
    const found = new Set<string>();
    for (const key of await kv.keys()) {
      const parsed = parseKey(key);
      if (parsed?.kind !== "download") continue;
      if ((await kv.get(key)) === ONLINE_ONLY) found.add(parsed.workspaceId);
    }
    emit(found);
  })().catch(() => {
    // A store that cannot list is a device that downloads everything, which is
    // the default anyway; the next session asks again.
    loaded = null;
  });
  return loaded;
}

/** Whether this device keeps no note bodies for this workspace. */
export function isOnlineOnly(workspaceId: string): boolean {
  return onlineOnly.has(workspaceId);
}

/** The mirror's question: does this device keep this note's body? */
export function keepsBody(workspaceId: string, path: string): boolean {
  return !onlineOnly.has(workspaceId) && downloadsPath(path);
}

/**
 * Set one workspace's choice. The in-memory answer changes at once, so the
 * sheet redraws on the tap; the write follows, and a failed write is said by
 * throwing so the caller can put the switch back.
 */
export async function setOnlineOnly(kv: KeyValueStore, workspaceId: string, value: boolean): Promise<void> {
  const before = onlineOnly;
  const next = new Set(onlineOnly);
  if (value) next.add(workspaceId);
  else next.delete(workspaceId);
  emit(next);
  try {
    if (value) await kv.set(keyFor("download", workspaceId), ONLINE_ONLY);
    else await kv.remove(keyFor("download", workspaceId));
  } catch (error) {
    emit(before);
    throw error;
  }
}

/** For sign-out: the next session reads the store again. */
export function forgetDownloadChoices(): void {
  loaded = null;
  emit(new Set());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): ReadonlySet<string> {
  return onlineOnly;
}

/** Every workspace this device keeps online only, re-rendering on change. */
export function useOnlineOnly(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Change listeners, for the sync to start a pass when a choice flips. */
export function onDownloadChoiceChange(listener: () => void): () => void {
  return subscribe(listener);
}
