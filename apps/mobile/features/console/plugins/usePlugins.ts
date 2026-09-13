import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import { fromInventoryRow, type PluginsView } from "./plugins";

type ScanState = Exclude<PluginsView, { state: "withheld" }>;

/**
 * This context's plugin inventory, bound to the control plane.
 *
 * `api.functions.files.listObsidianPlugins` is an **action**, not a query, and
 * that shapes everything here. It reaches past Convex to the gateway, which
 * lists `.obsidian/plugins/` and opens each plugin's `manifest.json` and
 * `main.js` — dozens of object reads in the customer's own bucket. There is no
 * subscription to hold and nothing to invalidate: what comes back is an answer
 * with a date on it, which is why the gateway's own report has carried a
 * `checkedAt` since it was written.
 *
 * So this does not read on mount. The view rests at `idle`, the reader presses
 * once, and the answer is held for as long as the console is open. A settings
 * pane that silently rescans somebody's whole vault every time it is opened is
 * a cost they did not ask for and cannot see.
 *
 * Owner-only, decided here rather than discovered from a thrown action. The
 * backend gate is `authorizeFileAccess(minimum: "owner")`; sending the call for
 * a member and rendering the refusal would be offering a button whose only
 * possible outcome is a permission error — the rule `useShares` and
 * `useAdvanced` already follow for `listShares` and `listEvents`.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function usePlugins(options: {
  workspaceId: Id<"workspaces"> | null;
  /** The caller's role in this context, or `undefined` while it is unknown. */
  role: string | undefined;
}): PluginsView {
  const { workspaceId, role } = options;
  const isOwner = role === "owner";
  const listPlugins = useAction(api.functions.files.listObsidianPlugins);

  /*
    The states a scan can actually be in. `withheld` is not one of them — it is
    decided from `role` before any call is made, so holding it here would be a
    second place that answer could come from.
  */
  const [view, setView] = useState<ScanState>({ state: "idle" });

  /*
    Switching context must not leave the previous context's plugins on screen
    under the new context's name — the whole section is per bucket. Reset to
    `idle` rather than to a stale `ready`, and drop any answer still in flight
    for the context we have navigated away from.
  */
  const requested = useRef(0);
  useEffect(() => {
    requested.current += 1;
    setView({ state: "idle" });
  }, [workspaceId, isOwner]);

  const read = useCallback(async () => {
    if (workspaceId === null || !isOwner) return;
    const ticket = requested.current;
    setView({ state: "loading" });
    try {
      const result = await listPlugins({ workspaceId });
      if (ticket !== requested.current) return;
      if (!result.available) {
        /*
          The provider's own words, quoted rather than paraphrased. `available:
          false` is a storage failure and says nothing about the customer's
          notes, which is the sentence the panel puts under it.
        */
        setView({ state: "failed", reason: result.reason ?? "the bucket could not be read" });
        return;
      }
      setView({
        state: "ready",
        inventory: {
          found: result.found,
          scanned: result.scanned,
          truncated: result.truncated,
          checkedAt: result.checkedAt,
          plugins: result.plugins.map(fromInventoryRow),
        },
      });
    } catch (error) {
      if (ticket !== requested.current) return;
      const failure = describeQueryFailure(error, "the plugins in this bucket");
      setView({
        state: "failed",
        reason: [failure.headline, failure.detail].filter(Boolean).join(" — "),
      });
    }
  }, [isOwner, listPlugins, workspaceId]);

  if (!isOwner) return { state: "withheld" };
  if (workspaceId === null) return { state: "idle" };
  // `loading` carries no control, so nothing can be pressed twice while a scan
  // is in flight.
  return view.state === "loading" ? view : { ...view, actions: { read } };
}
