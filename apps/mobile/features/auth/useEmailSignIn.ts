import { trackEvent } from "../observability/client";
import { useRef, useState } from "react";
import { Platform } from "react-native";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@context/convex/_generated/api";
import { adClickId } from "./adClickId";
import { adCampaign } from "./adCampaign";
import { landingPage } from "./landingPage";
import { reportWaitlistSignUp } from "./xPixel";
import { metaBrowserIds } from "./metaBrowserIds";
import { reportMetaLead } from "./metaPixel";
import { OTP_LENGTH } from "./CodeBoxes";
import { normalizeSignInEmail, signInProviderForEmail } from "./email";

/**
 * The one email field, as state: sign in if you're let in, join the list if not.
 *
 * Context is invite-only (Dev2, 2026-09-28), and the owner wanted the waitlist
 * and sign-in to be the same field. So the address is asked about first
 * (`waitlist.enter`), and only an `admitted` answer goes on to request a code.
 * Everyone else sees "you're on the list" in place, never an error.
 *
 * The server refuses a code to anybody not let in whatever this draws
 * (`apps/convex/functions/lib/waitlist.ts`); this hook is the explanation.
 *
 * The fixed-code test accounts (`signInProviderForEmail`) skip the question:
 * their providers only ever sign in their own address.
 *
 * Shared by `/login` and the homepage's `JoinCard`, so the two can never tell
 * one address two different things.
 */
export type EmailSignInStep = "request" | "verify" | "joined" | "already";

export const SEND_FAILED = "Couldn't send your code. Check the address and try again.";
export const CODE_FAILED = "That code didn't work. Codes last ten minutes, so ask for a new one if it's been a while.";
export const BUSY = "Lots of people are joining right now. Try again in a minute.";

/**
 * Said when an address has been sent as many codes as it may be for now
 * (`apps/convex/functions/lib/emailCodeSends.ts`). The newest code already
 * sent still works, so that is the first thing to try.
 */
export function tooManyCodes(retryAfterMs: number | undefined): string {
  const minutes = Math.max(1, Math.ceil((retryAfterMs ?? 15 * 60 * 1000) / 60_000));
  return `We've sent several codes already. Use the newest one in your inbox, or ask for another in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/** The message for a failed send: too many codes, too busy, or anything else. */
export function sendError(caught: unknown): string {
  const data = caught instanceof ConvexError ? (caught.data as { code?: string; retryAfterMs?: number } | undefined) : undefined;
  if (data?.code === "TOO_MANY_CODES") return tooManyCodes(data.retryAfterMs);
  if (data?.code === "RATE_LIMITED") return BUSY;
  return SEND_FAILED;
}

export function useEmailSignIn(options: { source: "homepage" | "login"; onSignedIn: () => void }) {
  const { signIn } = useAuthActions();
  const enter = useMutation(api.functions.waitlist.enter);
  const describe = useMutation(api.functions.waitlist.describe);

  const [step, setStep] = useState<EmailSignInStep>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const engaged = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [described, setDescribed] = useState(false);

  async function sendCode(normalized: string, again: boolean) {
    await signIn(signInProviderForEmail(normalized), { email: normalized });
    trackEvent("signup_result", { method: "email", source: options.source, result: "sent", resend: again });
    setStep("verify");
    setResent(again);
    if (again) setCode("");
  }

  async function submitEmail() {
    setError(null);
    setSubmitting(true);
    const normalized = normalizeSignInEmail(email);
    trackEvent("signup_submitted", { method: "email", source: options.source, resend: false });
    try {
      if (signInProviderForEmail(normalized) !== "email") {
        await sendCode(normalized, false);
        return;
      }
      const twclid = adClickId();
      const landing = landingPage();
      const campaign = adCampaign();
      const { status, conversionId } = await enter({
        email: normalized,
        source: options.source,
        ...(twclid === undefined ? {} : { twclid }),
        ...(landing === undefined ? {} : { landing }),
        ...(campaign === undefined ? {} : { campaign }),
        ...metaBrowserIds(),
        // Never reported to an ad network from inside the app (`waitlist.enter`).
        ...(Platform.OS === "web" ? {} : { app: "native" as const }),
      });
      if (status === "admitted") await sendCode(normalized, false);
      else {
        if (status === "joined") {
          reportWaitlistSignUp(conversionId);
          reportMetaLead(conversionId);
        }
        trackEvent("signup_result", { method: "email", source: options.source, result: status });
        setStep(status);
      }
    } catch (caught) {
      const message = sendError(caught);
      trackEvent("signup_result", { method: "email", source: options.source, result: message === SEND_FAILED ? "failed" : "limited" });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    setError(null);
    setSubmitting(true);
    try {
      trackEvent("signup_submitted", { method: "email", source: options.source, resend: true });
      await sendCode(normalizeSignInEmail(email), true);
    } catch (caught) {
      const message = sendError(caught);
      trackEvent("signup_result", { method: "email", source: options.source, result: message === SEND_FAILED ? "failed" : "limited", resend: true });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(value = code) {
    if (value.trim().length !== OTP_LENGTH) return;
    setError(null);
    setSubmitting(true);
    trackEvent("signin_code_submitted", { method: "email", source: options.source });
    try {
      const normalized = normalizeSignInEmail(email);
      const result = await signIn(signInProviderForEmail(normalized), { email: normalized, code: value.trim() });
      trackEvent("signin_code_result", { method: "email", source: options.source, result: result.signingIn ? "success" : "failed" });
      if (result.signingIn) options.onSignedIn();
      else setError(CODE_FAILED);
    } catch {
      trackEvent("signin_code_result", { method: "email", source: options.source, result: "failed" });
      setError(CODE_FAILED);
    } finally {
      setSubmitting(false);
    }
  }

  /** The optional "what would you use it for?" answer. Best effort, said once. */
  async function sendUseFor(answer: string) {
    if (answer.trim().length === 0) return;
    setDescribed(true);
    try {
      await describe({ email: normalizeSignInEmail(email), useFor: answer });
    } catch {
      // Optional, and saying it failed would only add a second thing to do.
    }
  }

  function changeEmail() {
    if (submitting) return;
    setStep("request");
    setCode("");
    setError(null);
    setResent(false);
    setDescribed(false);
  }

  return {
    step,
    email,
    setEmail: (value: string) => {
      if (!engaged.current && value.trim() !== "") {
        engaged.current = true;
        trackEvent("signup_started", { method: "email" });
      }
      setEmail(value);
      setError(null);
    },
    code,
    setCode: (value: string) => {
      setCode(value);
      setError(null);
    },
    submitting,
    error,
    resent,
    described,
    canSubmit: step === "request" ? email.trim().length > 3 : code.trim().length === OTP_LENGTH,
    submitEmail,
    resend,
    verify,
    sendUseFor,
    changeEmail,
  };
}

export type EmailSignIn = ReturnType<typeof useEmailSignIn>;
