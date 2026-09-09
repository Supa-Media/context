import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import {
  browserOrigin,
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
  start: (syncServices: GoogleSyncServices) => void;
} {
  const startConnect = useAction(api.functions.googleConnect.startGoogleConnect);
  const [state, setState] = useState<GoogleStartState>({ kind: "idle" });
  const redirectUri = googleRedirectUri(browserOrigin());

  const start = useCallback(
    (syncServices: GoogleSyncServices) => {
      if (workspaceId === null || redirectUri === null) return;
      setState({ kind: "starting" });
      void (async () => {
        try {
          const { authorizeUrl, completionSecret } = await startConnect({
            workspaceId: workspaceId as Id<"workspaces">,
            redirectUri,
            syncServices,
          });
          const oauthState = stateFromGoogleAuthorizeUrl(authorizeUrl);
          if (oauthState === null || !rememberGoogleCompletionSecret(oauthState, completionSecret)) {
            setState({
              kind: "failed",
              message: "This browser could not keep the Google connection secret. Try again.",
            });
            return;
          }
          leaveForGoogle(authorizeUrl);
        } catch {
          setState({
            kind: "failed",
            message: "Google did not start the connection. Try again.",
          });
        }
      })();
    },
    [redirectUri, startConnect, workspaceId],
  );

  return { redirectUri, state, start };
}
