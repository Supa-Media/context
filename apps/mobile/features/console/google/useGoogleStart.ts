import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  browserOrigin,
  describeGoogleStartFailure,
  googleRedirectUri,
  rememberGoogleCompletionSecret,
  stateFromGoogleAuthorizeUrl,
  type GoogleStartState,
  type GoogleSyncServices,
} from "./google";
import { leaveForGoogle } from "./leaveForGoogle";

export function useGoogleStart(workspaceId: string | null): {
  redirectUri: string | null;
  state: GoogleStartState;
  /** `loginHint` is the address of an account being reconnected. */
  start: (syncServices: GoogleSyncServices, loginHint?: string) => void;
} {
  const startConnect = useAction(api.functions.googleConnect.startGoogleConnect);
  const [state, setState] = useState<GoogleStartState>({ kind: "idle" });
  const redirectUri = googleRedirectUri(browserOrigin());

  const start = useCallback(
    (syncServices: GoogleSyncServices, loginHint?: string) => {
      if (workspaceId === null || redirectUri === null) return;
      setState({ kind: "starting" });
      void (async () => {
        try {
          const { authorizeUrl, completionSecret } = await startConnect({
            workspaceId: workspaceId as Id<"workspaces">,
            redirectUri,
            syncServices,
            ...(loginHint === undefined ? {} : { loginHint }),
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
