import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  browserOrigin,
  describeGoogleStartFailure,
  googleBackfillDays,
  googleRedirectUri,
  rememberGoogleCompletionSecret,
  stateFromGoogleAuthorizeUrl,
  type GoogleBackfillWindow,
  type GoogleStartState,
  type GoogleSyncServices,
} from "./google";
import { leaveForGoogle } from "./leaveForGoogle";

export function useGoogleStart(workspaceId: string | null): {
  redirectUri: string | null;
  state: GoogleStartState;
  start: (syncServices: GoogleSyncServices, backfillWindow: GoogleBackfillWindow) => void;
} {
  const startConnect = useAction(api.functions.googleConnect.startGoogleConnect);
  const [state, setState] = useState<GoogleStartState>({ kind: "idle" });
  const redirectUri = googleRedirectUri(browserOrigin());

  const start = useCallback(
    (syncServices: GoogleSyncServices, backfillWindow: GoogleBackfillWindow) => {
      if (workspaceId === null || redirectUri === null) return;
      setState({ kind: "starting" });
      void (async () => {
        try {
          const { authorizeUrl, completionSecret } = await startConnect({
            workspaceId: workspaceId as Id<"workspaces">,
            redirectUri,
            syncServices,
            backfillDays: googleBackfillDays(backfillWindow),
          });
          const oauthState = stateFromGoogleAuthorizeUrl(authorizeUrl);
          if (oauthState === null || !rememberGoogleCompletionSecret(oauthState, completionSecret)) {
            setState({
              kind: "failed",
              headline: "Could not start Google",
              message: "This browser could not keep the Google connection secret. Try again.",
            });
            return;
          }
          leaveForGoogle(authorizeUrl);
        } catch (error) {
          setState(describeGoogleStartFailure(error));
        }
      })();
    },
    [redirectUri, startConnect, workspaceId],
  );

  return { redirectUri, state, start };
}
