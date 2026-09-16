import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { describeQueryFailure } from "../failure";
import type { ManagedInstall, ManagedInstallsView } from "./managedInstalls";

/**
 * What Context installed in this bucket, read when the pane opens.
 *
 * ## It reads on mount, unlike `usePlugins` and like `useContextPlugins`
 *
 * The rule those two split on is cost, not caution. A scan opens every bundle
 * in somebody's vault — dozens of object reads they did not ask for — so it
 * waits to be asked. This reads one small pointer per plugin Context itself
 * installed, in Context's own directory, and opens none of them.
 *
 * Waiting to be asked was not free. The plugins pane rested at "Read the
 * plugins in this bucket" on arrival, so the screen that installs plugins could
 * not name a single one it had installed, and the registry beside it offered
 * Install on rows already installed. People installed the same plugin over and
 * over and reported that installs do not persist. They always had.
 *
 * Owner-only, decided here from `role` rather than discovered from a thrown
 * action — `listManagedPlugins` gates at `owner`, and sending a call whose only
 * possible outcome is a permission error is not an offer worth making. Same
 * rule as `usePlugins` beside it.
 *
 * Called from `useLiveConsoleData`, which owns every subscription the console
 * makes — do not call this from a pane.
 */
export function useManagedInstalls(options: {
  workspaceId: Id<"workspaces"> | null;
  role: string | undefined;
}): ManagedInstallsView {
  const { workspaceId, role } = options;
  const isOwner = role === "owner";
  const listInstalls = useAction(api.functions.files.listManagedPlugins);

  type Answer =
    | { state: "loading" }
    | { state: "ready"; installs: ManagedInstall[]; truncated: boolean }
    | { state: "failed"; reason: string };
  const [view, setView] = useState<Answer>({ state: "loading" });
  /*
    Switching context must not leave one bucket's installs on screen under
    another's name, and an answer still in flight for the context we navigated
    away from must not land on top of the new one.
  */
  const requested = useRef(0);

  const read = useCallback(async () => {
    requested.current += 1;
    const ticket = requested.current;
    if (workspaceId === null || !isOwner) return;
    setView({ state: "loading" });
    try {
      const result = await listInstalls({ workspaceId });
      if (ticket !== requested.current) return;
      if (!result.available) {
        // The provider's own words, like the inventory's `failed` beside it. A
        // storage failure here says nothing about what is installed, and the
        // panel's sentence is careful to say so rather than draw an empty list.
        setView({ state: "failed", reason: result.reason ?? "the bucket could not be read" });
        return;
      }
      setView({ state: "ready", installs: result.installs, truncated: result.truncated });
    } catch (error) {
      if (ticket !== requested.current) return;
      const failure = describeQueryFailure(error, "the plugins Context installed");
      setView({
        state: "failed",
        reason: [failure.headline, failure.detail].filter(Boolean).join(" — "),
      });
    }
  }, [isOwner, listInstalls, workspaceId]);

  useEffect(() => {
    void read();
  }, [read]);

  if (!isOwner) return { state: "withheld" };
  return { ...view, read };
}
