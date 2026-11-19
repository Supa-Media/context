/**
 * The "Staff only" screen of tex.lc/lab and the staff console: says which account is signed in and offers another,
 * so a person on the wrong account can see it and switch without hunting for the app's settings (Dev2, 2026-11-18:
 * "where does it show what account i am signed in as ... and allow me to sign in or switch accounts"). After the
 * new sign-in, `/login?next=` brings them back to this same page. The email is `mySetup`'s, a query the app's
 * layout already holds, so this adds no round trip.
 */
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { forgetLocalCopies, unsentOnDevice } from "../offline/forget";
import { resetObservabilityUser } from "../observability/client";

/**
 * `useSwitchAccount`'s steps, on the web without the router (which the staff console's tests cannot load): edits
 * still waiting to sync stay for the next sign-in, the session ends, then a full page load to sign-in and back here.
 */
function useSwitchToSignIn(): () => void {
  const { signOut } = useAuthActions();
  return () =>
    void (async () => {
      const unsent = await unsentOnDevice(null);
      if (unsent.pending + unsent.conflicted + unsent.rejected === 0) await forgetLocalCopies();
      await signOut();
      resetObservabilityUser();
      window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    })();
}

export function StaffOnly({ runs, testID, textClass }: { runs: string; testID: string; textClass: string }) {
  const setup = useQuery(api.functions.accountSetup.mySetup, {});
  const switchAccount = useSwitchToSignIn();
  return (
    <div className="pgin" data-testid={testID} style={{ paddingTop: 60 }}>
      <h1>Staff only</h1>
      <p className={textClass}>
        {`This page is for the people who run ${runs}. `}
        {setup?.email ? (
          <>
            You are signed in as <b data-testid="staff-only-email">{setup.email}</b>, which is not a staff account.
          </>
        ) : (
          "This account is not a staff account."
        )}
      </p>
      <button type="button" className="primary" data-testid="staff-only-switch" onClick={switchAccount}>
        Use another account
      </button>
    </div>
  );
}
