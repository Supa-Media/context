import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { observedUserId, onObservedUserChange } from "../observability/client";
import { startAppearanceSync, syncAppearanceWithAccount } from "./appearance";

/**
 * Keeps the Light / Dark choice following the account while someone is
 * signed in. Mounted once, at the root (`app/_layout.tsx`), so it runs on the
 * homepage and on sign-in screens as well as in the console — the choice is
 * the person's, not one screen's.
 *
 * The account id is the one the Feedback switches sync against
 * (`useAccountTelemetrySync`), so both device copies are about one person.
 */
export function useAccountAppearanceSync(): void {
  const me = useSyncExternalStore(onObservedUserChange, observedUserId, observedUserId);
  const remote = useQuery(api.functions.appearance.myAppearance, me === null ? "skip" : {});
  const save = useMutation(api.functions.appearance.setMyAppearance);

  useEffect(() => {
    if (me === null) return;
    return startAppearanceSync(me, (appearance) => save({ appearance }));
  }, [me, save]);

  useEffect(() => {
    if (me === null || remote === undefined) return;
    void syncAppearanceWithAccount(remote, me, (appearance) => save({ appearance }));
  }, [me, remote, save]);
}
