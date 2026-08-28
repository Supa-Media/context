import { useCallback, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { browserOrigin, dropboxRedirectUri, type DropboxStartState } from "./dropbox";
import { describeThrownStorageError } from "./errors";
import { leaveForDropbox } from "./leaveForDropbox";

/**
 * Starting a Dropbox connect: ask the control plane for a URL, then leave.
 *
 * There is deliberately nothing else here. The verifier, the state and the app
 * key all stay server-side — `startDropboxConnect` returns a URL and nothing
 * else — so this hook holds no secret, and a script that read every value in
 * it would have exactly what the address bar is about to show anyway.
 *
 * The navigation is `leaveForDropbox`, not `router`: Expo Router only knows
 * our own routes. It is platform-split for the same reason the consent
 * screen's is, and it re-checks that the URL really is Dropbox's before
 * following it.
 */
export function useDropboxStart(
  workspaceId: string | null,
  options: { resumeTo?: "onboarding" } = {},
): {
  /** `null` where Dropbox will not redirect back to this origin. */
  redirectUri: string | null;
  state: DropboxStartState;
  start: (folder?: string) => void;
} {
  const startConnect = useAction(api.functions.dropboxConnect.startDropboxConnect);
  const [state, setState] = useState<DropboxStartState>({ kind: "idle" });

  // Read at render rather than in an effect: it is a property of the document
  // this code is running in, it cannot change without a reload, and a state
  // update to learn it would paint one frame of "not available here".
  const redirectUri = dropboxRedirectUri(browserOrigin());

  const start = useCallback(
    (folder?: string) => {
      if (workspaceId === null || redirectUri === null) return;
      setState({ kind: "starting" });
      void (async () => {
        try {
          const { authorizeUrl } = await startConnect({
            workspaceId: workspaceId as Id<"workspaces">,
            redirectUri,
            // Omitted rather than sent as an empty string. `undefined` is what
            // the backend reads as "the app folder itself", and it is the
            // answer for every context but a second one on the same account.
            ...(folder === undefined ? {} : { rootPrefix: folder }),
            // Parked with the attempt, because the redirect destroys the page
            // that started it and Dropbox's exact-match redirect URI can carry
            // nothing. This is how first-run gets its remaining steps back.
            ...(options.resumeTo === undefined ? {} : { resumeTo: options.resumeTo }),
          });
          leaveForDropbox(authorizeUrl);
          // Left deliberately in `starting`. On web this line runs while the
          // browser is already navigating away; dropping back to `idle` would
          // flash an enabled button for the frame before the page goes.
        } catch (error) {
          setState({ kind: "failed", failure: describeThrownStorageError(error, "dropbox") });
        }
      })();
    },
    [options.resumeTo, redirectUri, startConnect, workspaceId],
  );

  return { redirectUri, state, start };
}
