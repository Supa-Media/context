import { useCallback } from "react";
import { useAction, useConvex } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { ConsoleGrantCache } from "./consoleGrantCache";

const sessions = new WeakMap<object, { session: string | null; cache: ConsoleGrantCache }>();

/** Account changes discard the cache; credentials never enter persistent storage. */
export function useConsoleGrant() {
  const client = useConvex();
  const session = useAuthToken();
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  let entry = sessions.get(client);
  if (!entry || entry.session !== session) {
    // This distinguishes app instances, not authority; only the server's opaque
    // bearer authorizes access. The fallback also works in native runtimes.
    const instanceId = globalThis.crypto?.randomUUID?.() ??
      `console-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    entry = { session, cache: new ConsoleGrantCache(instanceId) };
    sessions.set(client, entry);
  }
  const cache = entry.cache;
  return useCallback(({ workspaceId }: { workspaceId: Id<"workspaces"> }, force = false) => {
    if (!session || sessions.get(client)?.cache !== cache) return Promise.reject(new Error("Not authenticated"));
    return cache.get(workspaceId, () => mint({ workspaceId, consoleInstanceId: cache.instanceId }), force);
  }, [cache, client, mint, session]);
}
