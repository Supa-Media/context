import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";
import type { Reachability } from "./copy";

/**
 * Whether we can reach anything — native.
 *
 * `@react-native-community/netinfo`, which is already in `native-deps.json`'s
 * `core` baseline and already in `package.json`, so this costs no new native
 * dependency and no `runtimeVersion` bump. It was installed and unused before
 * this feature; this is what it was for.
 *
 * ## Why `isInternetReachable` is only allowed to say "no"
 *
 * NetInfo reports two things: `isConnected` (there is an interface) and
 * `isInternetReachable` (a probe got an answer). The second is `null` until the
 * probe has run and can stay `null` on some platforms, so treating "not true"
 * as offline would report a working phone as offline on every cold start.
 *
 * So: an explicit `false` from either field means offline, `isConnected === true`
 * means online, and anything else is `unknown` — which the console renders as
 * no claim at all. The direction that matters is the same one the web half
 * documents: a false negative costs a save that hangs and is queued thirty
 * seconds later, and a false positive costs an "Offline" chip on a phone that
 * is fine, which is the one that teaches people to ignore it.
 */
export function useReachability(): Reachability {
  const [state, setState] = useState<Reachability>("unknown");

  useEffect(() => {
    // `addEventListener` fires immediately with the current state, so there is
    // no separate initial fetch to race against the subscription.
    const unsubscribe = NetInfo.addEventListener((netInfo) => {
      if (netInfo.isConnected === false || netInfo.isInternetReachable === false) {
        setState("offline");
        return;
      }
      setState(netInfo.isConnected === true ? "online" : "unknown");
    });
    return unsubscribe;
  }, []);

  return state;
}
