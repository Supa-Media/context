import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { forgetLocalCopies, unsentOnDevice } from "../offline/forget";
import { resetObservabilityUser } from "../observability/client";

/**
 * "Use another account": end this session so somebody else can sign in, then
 * go to `next` — `/` from the phone check, `/login?next=/vault/<token>` from a
 * vault link sent to a different account, so the right person lands back on
 * it.
 *
 * Edits still waiting to sync stay on the device for the next sign-in rather
 * than being dropped by a sign-out from a screen that never showed them; with
 * nothing waiting, the local copies go, as the console's own sign-out clears
 * them.
 */
export function useSwitchAccount(): (next: string) => void {
  const router = useRouter();
  const { signOut } = useAuthActions();
  return useCallback(
    (next: string) => {
      void (async () => {
        const unsent = await unsentOnDevice(null);
        if (unsent.pending + unsent.conflicted + unsent.rejected === 0) await forgetLocalCopies();
        await signOut();
        resetObservabilityUser();
        router.replace(next);
      })();
    },
    [router, signOut],
  );
}
