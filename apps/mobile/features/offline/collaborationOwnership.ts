import { parseKey } from "./keys";
import type { KeyValueStore } from "./memory";

/**
 * Durable collaboration records are the handoff marker for a note. Once one
 * exists, the legacy whole-file outbox must remain parked until the
 * collaboration controller explicitly adopts that exact draft.
 */
export async function collaborationOwnedPaths(
  store: KeyValueStore,
  workspaceId: string,
): Promise<Set<string>> {
  const owned = new Set<string>();
  for (const key of await store.keys()) {
    const parsed = parseKey(key);
    if (parsed?.kind === "collaboration" && parsed.workspaceId === workspaceId) {
      owned.add(parsed.path);
    }
  }
  return owned;
}
