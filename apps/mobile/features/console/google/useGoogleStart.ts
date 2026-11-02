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
  /**
   * The second consent, to the agent client, for an account already
   * connected: what AI reads through once AI access to Google is split from
   * the person's own (functions/googleClients.ts). Same callback, same
   * completion secret handling.
   */
  allowAi: (connectionId: string) => void;
} {
  const startConnect = useAction(api.functions.googleConnect.startGoogleConnect);
  const startAgentConnect = useAction(api.functions.googleClients.startGoogleAgentConnect);
  const [state, setState] = useState<GoogleStartState>({ kind: "idle" });
  const redirectUri = googleRedirectUri(browserOrigin());

  const go = useCallback(
    (begin: () => Promise<{ authorizeUrl: string; completionSecret: string }>) => {
      setState({ kind: "starting" });
      void (async () => {
        try {
          const { authorizeUrl, completionSecret } = await begin();
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
    [],
  );

  const start = useCallback(
    (syncServices: GoogleSyncServices, loginHint?: string) => {
      if (workspaceId === null || redirectUri === null) return;
      go(() =>
        startConnect({
          workspaceId: workspaceId as Id<"workspaces">,
          redirectUri,
          syncServices,
          ...(loginHint === undefined ? {} : { loginHint }),
        }),
      );
    },
    [go, redirectUri, startConnect, workspaceId],
  );

  const allowAi = useCallback(
    (connectionId: string) => {
      if (workspaceId === null || redirectUri === null) return;
      go(() =>
        startAgentConnect({
          workspaceId: workspaceId as Id<"workspaces">,
          connectionId: connectionId as Id<"googleConnections">,
          redirectUri,
        }),
      );
    },
    [go, redirectUri, startAgentConnect, workspaceId],
  );

  return { redirectUri, state, start, allowAi };
}
