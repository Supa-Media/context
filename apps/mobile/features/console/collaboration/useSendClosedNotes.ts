import { useEffect, useRef } from "react";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { gatewayOriginFrom } from "../../meetings/gateway";
import { currentEpoch } from "../../offline/epoch";
import { useReachability } from "../../offline/reachability";
import { openStore } from "../../offline/store";
import { sendClosedNotes } from "./closedNotes";
import { collaborationTransport } from "./transport";

/**
 * Once per reconnection, and on launch, send the typing closed shared notes
 * left on this device (`closedNotes.ts`). Mounted once, beside the background
 * drain of the other contexts' queues, and never two passes at once.
 */
export function useSendClosedNotes(endpoint: string | null): void {
  const reachability = useReachability();
  const mint = useConsoleGrant();
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const running = useRef(false);

  useEffect(() => {
    if (reachability === "offline" || running.current || endpoint === null) return;
    const origin = gatewayOriginFrom(endpoint);
    if (origin === null) return;
    running.current = true;
    const epoch = currentEpoch();
    void sendClosedNotes(openStore(), {
      transport: (workspaceId) =>
        collaborationTransport(origin, async (rejected) => {
          const grant = await mintRef.current({ workspaceId: workspaceId as never }, rejected === undefined ? false : { rejected });
          return grant.accessToken;
        }),
      mine: () => epoch === currentEpoch(),
      online: () => typeof navigator === "undefined" || navigator.onLine !== false,
    })
      .catch(() => {
        // Whatever was not sent stays in its record for the next reconnection.
      })
      .finally(() => {
        running.current = false;
      });
  }, [endpoint, reachability]);
}
