import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { RECOVER_CONFIRMATION, type BrowseView, type CommunityPlugin } from "./lifecycle";

/**
 * Browsing the official registry, and installing or removing what Context
 * manages.
 *
 * Actions rather than queries, all four of them, and each one reaches the
 * network or the customer's bucket: `searchCommunityPlugins` fetches Obsidian's
 * registry, and install, uninstall and recover move real bytes. So nothing here
 * runs on mount — a settings pane that fetched a third-party registry every time
 * it opened would be making a request on somebody's behalf that they did not
 * ask for, on a screen they came to read.
 *
 * Owner-only, decided from `role` before any call, like `usePlugins` and
 * `useGrants` beside it.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function useLifecycle(options: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
  /**
   * Re-read the inventory after a change, so the list stops describing the old
   * bucket.
   *
   * Optional because there is one moment it does not exist: while a scan is
   * already in flight, `PluginsView` carries no `read`. An install that lands in
   * that window is not lost — the scan it is waiting for is the one that will
   * see it.
   */
  onChanged?: () => Promise<void> | void;
}): BrowseView {
  const { workspaceId, role, onChanged } = options;
  const isOwner = role === "owner";

  const searchAction = useAction(api.functions.obsidianPlugins.searchCommunityPlugins);
  const installAction = useAction(api.functions.obsidianPlugins.installCommunityPlugin);
  const uninstallAction = useAction(api.functions.obsidianPlugins.uninstallCommunityPlugin);
  const recoverAction = useAction(api.functions.obsidianPlugins.recoverPluginLifecycle);

  const [results, setResults] = useState<CommunityPlugin[] | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /*
    A registry search and the bucket it is compared against both belong to one
    context. Carrying either across a switch would show one brain's results
    under another brain's name.
  */
  const ticket = useRef(0);
  useEffect(() => {
    ticket.current += 1;
    setResults(undefined);
    setQuery("");
    setFailure(null);
  }, [workspaceId, isOwner]);

  const search = useCallback(
    async (next: string) => {
      if (workspaceId === null || !isOwner) return;
      const mine = ticket.current;
      setQuery(next);
      setSearching(true);
      setFailure(null);
      try {
        const rows = await searchAction({ workspaceId, query: next });
        if (mine !== ticket.current) return;
        setResults(rows);
      } catch (error) {
        if (mine !== ticket.current) return;
        setFailure(lifecycleFailure(error));
      } finally {
        if (mine === ticket.current) setSearching(false);
      }
    },
    [isOwner, searchAction, workspaceId],
  );

  /**
   * One shape for the three operations that change the bucket.
   *
   * Each of them ends with the inventory on screen describing a bucket that no
   * longer exists, so each of them re-reads it. Doing that in one place is what
   * stops a fourth operation arriving later and quietly not refreshing.
   */
  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      if (workspaceId === null || !isOwner) return;
      const mine = ticket.current;
      setFailure(null);
      try {
        await operation();
        if (mine !== ticket.current) return;
        await onChanged?.();
      } catch (error) {
        if (mine !== ticket.current) return;
        setFailure(lifecycleFailure(error));
      }
    },
    [isOwner, onChanged, workspaceId],
  );

  const install = useCallback(
    (pluginId: string) =>
      run(() => installAction({ workspaceId: workspaceId as Id<"workspaces">, pluginId })),
    [installAction, run, workspaceId],
  );

  const uninstall = useCallback(
    (pluginId: string, bundleFingerprint: string) =>
      run(() =>
        uninstallAction({
          workspaceId: workspaceId as Id<"workspaces">,
          pluginId,
          bundleFingerprint,
        }),
      ),
    [run, uninstallAction, workspaceId],
  );

  const recover = useCallback(
    (pluginId: string) =>
      run(() =>
        recoverAction({
          workspaceId: workspaceId as Id<"workspaces">,
          pluginId,
          confirmation: RECOVER_CONFIRMATION,
        }),
      ),
    [recoverAction, run, workspaceId],
  );

  return {
    results,
    query,
    searching,
    failure,
    actions:
      isOwner && workspaceId !== null ? { search, install, uninstall, recover } : undefined,
  };
}

/**
 * The server's own refusal, kept.
 *
 * `installCommunityPlugin` and its siblings have specific things to say —
 * `PLUGIN_NOT_FOUND`, `PLUGIN_RELEASE_INVALID`, `PLUGIN_LIFECYCLE_BUSY` — and
 * each is more use to the reader than anything this hook could compose. The
 * fallback says what did not happen rather than that something went wrong,
 * because after a failed install the only question is whether the plugin is now
 * in the bucket.
 */
function lifecycleFailure(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") return message.trim();
  }
  if (typeof data === "string" && data.trim() !== "") return data.trim();
  return "That did not go through, and nothing in your bucket was changed.";
}

/** The code on a `ConvexError`, for deciding whether an operation is stuck. */
export function lifecycleErrorCode(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const code = (data as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
