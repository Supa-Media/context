import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { DEFAULT_LOOK, lookOf, sameLook, type MapLook } from "../look";

/** How long a slider may keep moving before the choice is written to the account. */
export const SAVE_AFTER_MS = 700;

/**
 * The person's map settings: read from the account, changed at once on screen,
 * and written back a moment after the last change, so dragging a slider is one
 * save and not fifty. A demo or a fixture map keeps its changes on the page
 * only (`account` false): there is no account to keep them on.
 */
export function useMapLook(account: boolean): { look: MapLook; setLook: (patch: Partial<MapLook>) => void; reset: () => void } {
  const remote = useQuery(api.functions.mapLook.myMapLook, account ? {} : "skip");
  const save = useMutation(api.functions.mapLook.setMyMapLook);
  const [local, setLocal] = useState<MapLook | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One object per stored record, so the map's data is not rebuilt every render.
  const raw = remote?.look;
  const stored = useMemo(() => (raw ? lookOf(raw) : DEFAULT_LOOK), [JSON.stringify(raw ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
  const look = local ?? stored;

  // Once the account has caught up with what is on screen, the account is the copy again.
  useEffect(() => {
    if (local !== null && pending.current === null && sameLook(local, stored)) setLocal(null);
  }, [local, stored]);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  const write = useCallback(
    (next: MapLook) => {
      setLocal(next);
      if (!account) return;
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = null;
        save({ look: next }).catch(() => {
          // Kept on screen; the next change tries again.
        });
      }, SAVE_AFTER_MS);
    },
    [account, save],
  );

  const setLook = useCallback((patch: Partial<MapLook>) => write(lookOf({ ...look, ...patch })), [look, write]);
  const reset = useCallback(() => write({ ...DEFAULT_LOOK }), [write]);
  return { look, setLook, reset };
}
