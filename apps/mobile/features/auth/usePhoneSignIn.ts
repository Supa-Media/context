import { useState } from "react";
import { useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { OTP_LENGTH } from "./CodeBoxes";
import { CODE_FAILED, startError, type StartStatus } from "./phoneSignIn";

/** The provider `apps/convex/auth.ts` registers for a texted code. */
export const PHONE_VERIFY_PROVIDER = "phone-verify";

/**
 * The phone field on the sign-in page, as state (Dev2, 2026-10-09).
 *
 * A phone an account holds, or one staff let in, is texted a code, and the
 * code signs in (making the account, for a let-in phone). Any other phone is
 * put on the waitlist and `waitlist` says so. Without Twilio on this
 * deployment, `onUnavailable` hands over to the email field.
 */
export function usePhoneSignIn(options: { onSignedIn: () => void; onUnavailable: () => void }) {
  const { signIn } = useAuthActions();
  const start = useAction(api.functions.phoneSignIn.start);

  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [waitlist, setWaitlist] = useState<"joined" | "already" | null>(null);

  async function send(again = false) {
    setError(null);
    setSubmitting(true);
    try {
      const result = (await start({ phone: sentTo ?? phone })) as { status: StartStatus; phone?: string };
      setError(startError(result.status));
      if (result.status === "sent" && result.phone !== undefined) {
        setSentTo(result.phone);
        setCode("");
        setResent(again);
      } else if (result.status === "joined" || result.status === "already") {
        setWaitlist(result.status);
      } else if (result.status === "unavailable") {
        options.onUnavailable();
      }
    } catch {
      setError(startError("failed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(value = code) {
    if (sentTo === null || value.length !== OTP_LENGTH) return;
    setError(null);
    setSubmitting(true);
    try {
      // A refused code answers "not signed in" rather than throwing.
      const result = await signIn(PHONE_VERIFY_PROVIDER, { phone: sentTo, code: value });
      if (result.signingIn) options.onSignedIn();
      else {
        setError(CODE_FAILED);
        setCode("");
      }
    } catch {
      setError(CODE_FAILED);
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  function changeNumber() {
    if (submitting) return;
    setWaitlist(null);
    setSentTo(null);
    setCode("");
    setError(null);
    setResent(false);
  }

  return {
    phone,
    setPhone: (value: string) => {
      setPhone(value);
      setError(null);
    },
    sentTo,
    code,
    setCode: (value: string) => {
      setCode(value);
      setError(null);
    },
    submitting,
    error,
    resent,
    waitlist,
    canSend: phone.trim().length >= 7,
    send,
    verify,
    changeNumber,
  };
}

export type PhoneSignIn = ReturnType<typeof usePhoneSignIn>;
