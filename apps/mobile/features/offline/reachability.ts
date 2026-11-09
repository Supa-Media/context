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
      setState(classify(netInfo));
    });
    return unsubscribe;
  }, []);

  return state;
}

/*
  The same reading, outside React, for code that asks at the moment it acts
  rather than rendering it: the live note's sender asks "may I send now?".
  It used to ask `navigator.onLine`, which React Native does not have, so on
  the phone the answer was always yes and a dead connection was found out by
  a request timing out. One NetInfo subscription for the life of the app,
  started by the first question; until NetInfo has answered, nothing is known
  to be offline.
*/
let known: Reachability = "unknown";
let watching = false;

function classify(netInfo: { isConnected: boolean | null; isInternetReachable: boolean | null }): Reachability {
  if (netInfo.isConnected === false || netInfo.isInternetReachable === false) return "offline";
  return netInfo.isConnected === true ? "online" : "unknown";
}

/** True only when the device says plainly that it has no connection. */
export function knownOffline(): boolean {
  if (!watching) {
    watching = true;
    NetInfo.addEventListener((netInfo) => {
      known = classify(netInfo);
    });
  }
  return known === "offline";
}
