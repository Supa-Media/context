import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@context/convex/_generated/api";
import { gatewayOriginFrom } from "../../meetings/gateway";
import { decodeAgentActivity, type AgentActivityView } from "./agentActivity";

/**
 * How often the tree asks.
 *
 * Each ask resolves a grant and reads `privacy.md`, so this is a cost per open
 * console, not a free refresh. The marks describe the last five minutes, and
 * half a minute is fresh enough for that claim. Nothing is polled while the
 * tab is hidden, and returning to it asks at once. A socket per workspace
 * would be quicker, but it would add a second long-lived connection to every
 * open console just to move a dot.
 */
export const AGENT_ACTIVITY_POLL_MS = 30_000;

/**
 * `GET /agent-activity` for the selected workspace, bound to React.
 *
 * `undefined` until the first answer lands, and on any console with no
 * gateway behind it. The explorer then draws exactly what it drew before this
 * existed. Every failure is silent: a sidebar that cannot say which agents are
 * active says nothing, and keeps the last answer it had only while it is
 * still about the same workspace.
 */
export function useAgentActivity(
  workspaceId: string | null,
  endpoint: string | null,
  /**
   * How often to ask. The setup guide asks every few seconds while it is
   * watching an agent write, because there somebody is looking at the list
   * waiting for it to move; everywhere else the sidebar's half minute holds.
   */
  pollMs: number = AGENT_ACTIVITY_POLL_MS,
): AgentActivityView | undefined {
  const mint = useAction(api.functions.agentGrant.mintConsoleGrant);
  const [view, setView] = useState<{ workspaceId: string; view: AgentActivityView } | null>(null);
  const mintRef = useRef(mint);
  mintRef.current = mint;

  useEffect(() => {
    const origin = endpoint === null ? null : gatewayOriginFrom(endpoint);
    if (workspaceId === null || origin === null || typeof fetch !== "function" || typeof window === "undefined") {
      setView(null);
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let grant: { accessToken: string; expiresAt: number } | null = null;

    let inFlight = false;
    // One timer at a time, however the last read was started.
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (!stopped) timer = setTimeout(read, pollMs);
    };
    const read = async () => {
      if (stopped || inFlight) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return;
      }
      inFlight = true;
      try {
        if (grant === null || grant.expiresAt - Date.now() < 60_000) {
          grant = await mintRef.current({ workspaceId: workspaceId as never });
        }
        const response = await fetch(new URL("/agent-activity", origin).toString(), {
          headers: { authorization: `Bearer ${grant.accessToken}` },
        });
        if (response.ok && !stopped) {
          setView({ workspaceId, view: decodeAgentActivity(await response.json()) });
        }
      } catch {
        // A quieter sidebar, until the next attempt.
      } finally {
        inFlight = false;
      }
      schedule();
    };

    // Asked again on the way back to the tab, rather than up to a poll late.
    // Only where there is a document to be hidden: a native shell has a
    // `window` with no events on it.
    const again = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void read();
    };
    const listens = typeof window.addEventListener === "function";
    void read();
    if (listens) window.addEventListener("visibilitychange", again);
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (listens) window.removeEventListener("visibilitychange", again);
    };
  }, [workspaceId, endpoint, pollMs]);

  // Never another workspace's marks on this one's tree, even for a frame.
  return view !== null && view.workspaceId === workspaceId ? view.view : undefined;
}
