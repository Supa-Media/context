import { useEffect, useState } from "react";
import type { Reachability } from "./copy";

/**
 * Whether we can reach anything — web.
 *
 * `navigator.onLine` plus the two events that change it, and nothing cleverer.
 * The well-known caveat is that `onLine === true` means "there is a network
 * interface", not "the internet answers", so a captive portal or a dead uplink
 * reads as online. That is why this is only *half* of how the app decides what
 * to do: a save made while this says "online" still goes through the ordinary
 * path, and a request that then fails is handled by the queue exactly as an
 * offline one is. What this hook buys is the other direction — `false` is
 * reliable, and it is the one that lets a save be queued *instead of* being
 * dispatched into a socket that will never answer.
 *
 * That asymmetry matters more here than in most apps. `writeNote` is a Convex
 * **action** and `ConvexReactClient.action()` has no client-side timeout, so
 * offline it does not reject — it hangs until `SAVE_TIMEOUT_MS`. Deciding from
 * an error would mean thirty seconds of a spinner before anything was queued.
 *
 * `unknown` is returned where the property does not exist at all (an old
 * embedded webview, a server render). `copy.ts` renders nothing for it: a
 * permanent "Offline" chip on a browser that simply will not say is a chip
 * people stop seeing.
 */
export function useReachability(): Reachability {
  const [state, setState] = useState<Reachability>(() => read());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setState(read());
    // Read once on mount as well: the events only fire on a *change*, and the
    // browser may have gone offline between the first render and this effect.
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return state;
}

function read(): Reachability {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return "unknown";
  return navigator.onLine ? "online" : "offline";
}
