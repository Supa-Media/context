import { useEffect, useMemo, useState } from "react";
import { currentEpoch } from "./epoch";
import { readIndex } from "./mirror";
import { searchMirror, type DeviceSearchAnswer } from "./mirrorSearch";
import { openMirrorStore } from "./mirrorStore";
import { visibilityTierForRole } from "../console/visibility";

/**
 * The console's handles on the copy of a context that is on this device: a
 * search over it (`mirrorSearch.ts`) and the paths it holds, for quick open.
 *
 * Both take the context's **role** rather than a clearance, and derive the
 * clearance with `visibilityTierForRole` — the one place this app decides it,
 * and the same call `useMirrorSync` makes when it files what it downloads. So
 * what is searched is exactly the copy the sync wrote for this session, and an
 * `unknown` role reads nothing: `null` from both, which the palette treats as
 * "no device search to offer" rather than as an empty one.
 */

/**
 * A search over this device's copy of one context, or `null` where there is
 * none to offer. The function answers `null` when the device keeps no mirror
 * at all (`openMirrorStore`'s probe refused — a private window).
 */
export function useDeviceSearch(
  workspaceId: string | null,
  role: string | undefined,
): ((query: string) => Promise<DeviceSearchAnswer | null>) | null {
  const tier = visibilityTierForRole(role);
  return useMemo(() => {
    if (workspaceId === null || tier === "unknown") return null;
    return async (query: string) => {
      const store = await openMirrorStore();
      if (store === null) return null;
      return searchMirror(store, tier, workspaceId, query);
    };
  }, [workspaceId, tier]);
}

const NO_PATHS: readonly string[] = [];

/**
 * Every path the mirror holds for one context, read while `active` — the
 * palette open with no connection — and dropped when it is not.
 *
 * Read when asked rather than kept, for `palette.ts`'s reason: a list of note
 * names that outlives the moment it was read for is a list of notes that may
 * no longer be there.
 */
export function useMirrorPaths(
  workspaceId: string | null,
  role: string | undefined,
  active: boolean,
): readonly string[] {
  const tier = visibilityTierForRole(role);
  const [paths, setPaths] = useState<readonly string[]>(NO_PATHS);

  useEffect(() => {
    if (!active || workspaceId === null || tier === "unknown") {
      setPaths(NO_PATHS);
      return;
    }
    let cancelled = false;
    const epoch = currentEpoch();
    void (async () => {
      const store = await openMirrorStore();
      if (store === null) return;
      const index = await readIndex(store, tier, workspaceId);
      // A sign-out while this was reading: the names belong to a session that is over.
      if (cancelled || index === null || epoch !== currentEpoch()) return;
      setPaths([...index.entries.keys()]);
    })().catch(() => {
      // No names from the device is the palette as it was before this.
    });
    return () => {
      cancelled = true;
    };
  }, [active, workspaceId, tier]);

  return paths;
}
