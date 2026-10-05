import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@context/convex/_generated/api";
import { adClickId } from "./adClickId";
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

export function useEmailSignIn(options: { source: "homepage" | "login"; onSignedIn: () => void }) {
  const { signIn } = useAuthActions();
  const enter = useMutation(api.functions.waitlist.enter);
  const describe = useMutation(api.functions.waitlist.describe);

  const [step, setStep] = useState<EmailSignInStep>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [described, setDescribed] = useState(false);

  async function sendCode(normalized: string, again: boolean) {
    await signIn(signInProviderForEmail(normalized), { email: normalized });
    setStep("verify");
    setResent(again);
    if (again) setCode("");
  }

  async function submitEmail() {
    setError(null);
    setSubmitting(true);
    const normalized = normalizeSignInEmail(email);
    try {
      if (signInProviderForEmail(normalized) !== "email") {
        await sendCode(normalized, false);
        return;
      }
      const twclid = adClickId();
      const { status } = await enter({
        email: normalized,
        source: options.source,
        ...(twclid === undefined ? {} : { twclid }),
      });
      if (status === "admitted") await sendCode(normalized, false);
      else setStep(status);
    } catch (caught) {
      const code = caught instanceof ConvexError ? (caught.data as { code?: string } | undefined)?.code : undefined;
      setError(code === "RATE_LIMITED" ? BUSY : SEND_FAILED);
    } finally {
      setSubmitting(false);
    }
  }

  async function resend() {
    setError(null);
    setSubmitting(true);
    try {
      await sendCode(normalizeSignInEmail(email), true);
    } catch {
      setError(SEND_FAILED);
    } finally {
      setSubmitting(false);
    }
  }

  async function verify(value = code) {
    setError(null);
    setSubmitting(true);
    try {
      const normalized = normalizeSignInEmail(email);
      await signIn(signInProviderForEmail(normalized), { email: normalized, code: value.trim() });
      options.onSignedIn();
    } catch {
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
