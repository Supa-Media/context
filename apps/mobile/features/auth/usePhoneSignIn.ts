import { trackEvent } from "../observability/client";
import { useRef, useState } from "react";
import { useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { OTP_LENGTH } from "./CodeBoxes";
import { CODE_FAILED, startError, type StartStatus } from "./phoneSignIn";
import { adCampaign } from "./adCampaign";
import { landingPage } from "./landingPage";
import { reportMetaLead } from "./metaPixel";
import { reportWaitlistSignUp } from "./xPixel";
import { saveReceipt } from "../tex/launch/receipt";

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
  const engaged = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [waitlist, setWaitlist] = useState<"joined" | "already" | null>(null);
  // The last answer to `start`, for a page that words its own errors (tex.lc).
  const [startStatus, setStartStatus] = useState<StartStatus | null>(null);

  async function send(again = false) {
    setError(null);
    setSubmitting(true);
    trackEvent("signup_submitted", { method: "phone", resend: again });
    try {
      const landing = landingPage();
      const campaign = adCampaign();
      const result = (await start({
        phone: sentTo ?? phone,
        ...(landing === undefined ? {} : { landing }),
        ...(campaign === undefined ? {} : { campaign }),
      })) as { status: StartStatus; phone?: string; conversionId?: string; receipt?: string };
      const outcome = ["sent", "joined", "already", "unavailable", "invalid_phone", "too_many", "paused", "failed"].includes(result.status) ? result.status : "failed";
      trackEvent("signup_result", { method: "phone", result: outcome, resend: again });
      setError(startError(result.status));
      setStartStatus(result.status);
      if (result.status === "sent" && result.phone !== undefined) {
        setSentTo(result.phone);
        setCode("");
        setResent(again);
      } else if (result.status === "joined" || result.status === "already") {
        if (result.status === "joined") {
          // The same sign-up events as joining with an address, so an ad
          // counts a phone sign-up too (the landing pages lead with a phone).
          reportWaitlistSignUp(result.conversionId);
          reportMetaLead(result.conversionId);
          // This browser made the row, so it alone may come back to it
          // (`/waitlist`). Kept before the state change that may navigate.
          if (result.receipt !== undefined) saveReceipt(result.receipt);
        }
        setWaitlist(result.status);
      } else if (result.status === "unavailable") {
        options.onUnavailable();
      }
    } catch {
      trackEvent("signup_result", { method: "phone", result: "failed", resend: again });
      setError(startError("failed"));
      setStartStatus("failed");
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(value = code) {
    if (sentTo === null || value.length !== OTP_LENGTH) return;
    setError(null);
    setSubmitting(true);
    trackEvent("signin_code_submitted", { method: "phone" });
    try {
      // A refused code answers "not signed in" rather than throwing.
      const result = await signIn(PHONE_VERIFY_PROVIDER, { phone: sentTo, code: value });
      trackEvent("signin_code_result", { method: "phone", result: result.signingIn ? "success" : "failed" });
      if (result.signingIn) options.onSignedIn();
      else {
        setError(CODE_FAILED);
        setCode("");
      }
    } catch {
      trackEvent("signin_code_result", { method: "phone", result: "failed" });
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
      if (!engaged.current && value.trim() !== "") {
        engaged.current = true;
        trackEvent("signup_started", { method: "phone" });
      }
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
    startStatus,
    canSend: phone.trim().length >= 7,
    send,
    verify,
    changeNumber,
  };
}

export type PhoneSignIn = ReturnType<typeof usePhoneSignIn>;
