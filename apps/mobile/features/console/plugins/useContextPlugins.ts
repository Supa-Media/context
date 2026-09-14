import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import type { ContextPlugin, ContextPluginsView } from "./contextPlugins";

/**
 * The built-in plugins of one context, bound to the control plane.
 *
 * ## It reads on mount, unlike the inventory beside it
 *
 * `usePlugins` deliberately waits to be asked, because a scan opens every
 * bundle in somebody's vault — dozens of object reads they did not request.
 * This reads one small object, and the answer is the panel: a settings screen
 * that showed five rows only after you pressed a button would be asking
 * somebody to press a button to find out what their context can do.
 *
 * ## Any member reads; only an owner writes
 *
 * The role gate is the server's (`setPluginEnabled` refuses below `owner`), and
 * `canManage` comes back from it rather than being re-derived here. That is the
 * `useFastSearch` rule rather than the `usePlugins` one, and the difference is
 * on purpose: a scan is withheld from a member entirely, so the decision has to
 * be made before the call; here the list is theirs to see, and only the
 * controls are not — so the server's own answer is the one the panel draws.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function useContextPlugins(options: {
  workspaceId: Id<"workspaces"> | null;
}): ContextPluginsView {
  const { workspaceId } = options;
  const list = useAction(api.functions.contextPlugins.listPlugins);
  const set = useAction(api.functions.contextPlugins.setPluginEnabled);

  const [view, setView] = useState<ContextPluginsView>({ state: "loading" });
  const [pending, setPending] = useState<string | undefined>(undefined);

  /*
    Switching context must not leave one context's switches on screen under
    another's name. The ticket also drops an answer still in flight for the
    context we navigated away from — without it, a slow read of the previous
    bucket lands after the new one and silently describes the wrong workspace.
  */
  const requested = useRef(0);

  const apply = useCallback(
    (result: {
      plugins: ContextPlugin[];
      settingsError: string | null;
      canManage: boolean;
    }) => {
      setView({
        state: "ready",
        plugins: result.plugins,
        settingsError: result.settingsError,
        canManage: result.canManage,
      });
    },
    [],
  );

  useEffect(() => {
    requested.current += 1;
    const ticket = requested.current;
    setPending(undefined);
    if (workspaceId === null) {
      setView({ state: "loading" });
      return;
    }
    setView({ state: "loading" });
    void (async () => {
      try {
        const result = await list({ workspaceId });
        if (ticket !== requested.current) return;
        apply(result);
      } catch (error) {
        if (ticket !== requested.current) return;
        const failure = describeQueryFailure(error, "the plugins in this context");
        setView({
          state: "failed",
          reason: [failure.headline, failure.detail].filter(Boolean).join(" — "),
        });
      }
    })();
  }, [apply, list, workspaceId]);

  const setEnabled = useCallback(
    (pluginId: string, enabled: boolean) => {
      if (workspaceId === null) return;
      const ticket = requested.current;
      setPending(pluginId);
      void (async () => {
        try {
          const result = await set({ workspaceId, pluginId, enabled });
          if (ticket !== requested.current) return;
          /*
            The server's answer, not an optimistic flip. The write is one
            conditional write against a file another owner may have changed a
            second ago, so what comes back is what the bucket now says — which
            is the only thing a switch should be drawn from.
          */
          apply(result);
        } catch (error) {
          if (ticket !== requested.current) return;
          const failure = describeQueryFailure(error, "that plugin");
          setView({
            state: "failed",
            reason: [failure.headline, failure.detail].filter(Boolean).join(" — "),
          });
        } finally {
          if (ticket === requested.current) setPending(undefined);
        }
      })();
    },
    [apply, set, workspaceId],
  );

  if (view.state !== "ready") return view;
  // No controls while one is in flight: two switches pressed in the same second
  // are two read-modify-writes of one file, and the loser of that race is a
  // decision somebody made and did not get.
  if (pending !== undefined) return { ...view, pending };
  return { ...view, actions: { setEnabled } };
}
