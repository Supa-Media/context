import { useState } from "react";
import { useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { OTP_LENGTH } from "./CodeBoxes";
import { setPendingPhone } from "./pendingPhone";
import { CODE_FAILED, startError, type StartStatus } from "./phoneSignIn";

/** The provider `apps/convex/auth.ts` registers for a texted code. */
export const PHONE_VERIFY_PROVIDER = "phone-verify";

/**
 * The phone field on the sign-in page, as state (Dev2, 2026-10-09).
 *
 * A phone an account holds is texted a code, and the code signs in. A phone
 * nobody holds is kept (`pendingPhone`) and `onNewNumber` hands over to the
 * email field, whose sign-in is followed by the phone check for that number.
 * Without Twilio on this deployment, `onNewNumber` too: email still works.
 */
export function usePhoneSignIn(options: { onSignedIn: () => void; onNewNumber: () => void }) {
  const { signIn } = useAuthActions();
  const start = useAction(api.functions.phoneSignIn.start);

  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

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
      } else if (result.status === "new" || result.status === "unavailable") {
        if (result.status === "new" && result.phone !== undefined) setPendingPhone(result.phone);
        options.onNewNumber();
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
    canSend: phone.trim().length >= 7,
    send,
    verify,
    changeNumber,
  };
}

export type PhoneSignIn = ReturnType<typeof usePhoneSignIn>;
