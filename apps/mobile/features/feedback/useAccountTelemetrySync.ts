import { useEffect, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { observedUserId, onObservedUserChange } from "../observability/client";
import { startAccountSync, syncWithAccount } from "../observability/accountPreferences";

/**
 * Keeps the Privacy & feedback switches following the account while someone
 * is signed in. Mounted once, by `FeedbackHost` in the signed-in layout.
 *
 * The account id comes from telemetry's own record of who is signed in, the
 * same id Sentry and PostHog are given, so the switches and the data they
 * govern are about one person.
 */
export function useAccountTelemetrySync(): void {
  const me = useSyncExternalStore(onObservedUserChange, observedUserId, observedUserId);
  const remote = useQuery(api.functions.telemetry.myTelemetryPreferences, me === null ? "skip" : {});
  const save = useMutation(api.functions.telemetry.setMyTelemetryPreferences);

  useEffect(() => {
    if (me === null) return;
    return startAccountSync(me, (value) => save(value));
  }, [me, save]);

  useEffect(() => {
    if (me === null || remote === undefined) return;
    void syncWithAccount(remote, me, (value) => save(value));
  }, [me, remote, save]);
}
