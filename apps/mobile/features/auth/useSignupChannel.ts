import { useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { firstTouch, firstTouchSent, markFirstTouchSent } from "./firstTouch";

/**
 * Tells the server, once per device after signing in, the first touch this
 * browser saw (`./firstTouch`), so a new account gets its sign-up channel
 * (`signupChannels.fromApp`). The server ignores it for an account more than
 * an hour old or one that has a channel already. Mounted by `FeedbackHost` in
 * the signed-in layout.
 */
export function useSignupChannel(): void {
  const send = useMutation(api.functions.signupChannels.fromApp);
  useEffect(() => {
    if (firstTouchSent()) return;
    const touch = firstTouch();
    if (touch === undefined) return;
    send({ touch }).then(markFirstTouchSent, () => {
      // Tried again on the next open.
    });
  }, [send]);
}
