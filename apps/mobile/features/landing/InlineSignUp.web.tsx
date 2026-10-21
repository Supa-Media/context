import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { JoinCard, useHomeJoin } from "../auth/JoinCard";
import { landAfterSignIn } from "../auth/landing";
import { OTP_LENGTH } from "../auth/CodeBoxes";
import {
  PHONE_COUNTRIES,
  composePhone,
  countryByIso,
  countryOfNumber,
  DEFAULT_COUNTRY_ISO,
  type PhoneCountry,
} from "../auth/phoneCountries";
import {
  ALREADY_HEADING,
  JOINED_HEADING,
} from "../auth/phoneSignIn";
import { CONSOLE_ROUTE } from "../auth/redirect";
import { usePhoneSignIn } from "../auth/usePhoneSignIn";
import { ThemeProvider } from "../design/theme";

/**
 * The landing sign-up (`NotesPage.web`, styled by `signUpCss.ts`): a labelled phone field and a button that
 * says what it does (Dev, 2026-10-18: "signing up for the waitlist the button
 * to click enter isn't clear", replacing the bare › of 2026-10-12). +1 is
 * already there with a drop-down for other countries. The rules are the
 * sign-in page's (`usePhoneSignIn`): a number not let in joins the waitlist in
 * place, one that is in is texted a code, and each later step is drawn in the
 * same place. Email swaps in the homepage's email card, the same fallback the
 * old form had.
 */
const CHEVRON = (
  <svg viewBox="0 0 10 10" aria-hidden>
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </svg>
);

/** What happens next for somebody on the list: the "You're in" text names Tex (`waitlistText.ts`). */
export const LISTED_NEXT = "When you're let in, we'll text you Tex's number. Text it hello and Tex sets you up.";

export function InlineSignUp() {
  const [mode, setMode] = useState<"phone" | "email">("phone");
  const router = useRouter();
  const replace = (href: string) => router.replace(href as never);
  const flow = usePhoneSignIn({
    onSignedIn: () => landAfterSignIn(CONSOLE_ROUTE, replace),
    onUnavailable: () => setMode("email"),
  });
  const email = useHomeJoin({ replace });
  const answered = useRef(0);
  const [country, setCountry] = useState<PhoneCountry>(() =>
    countryByIso(DEFAULT_COUNTRY_ISO),
  );
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const step =
    flow.waitlist !== null
      ? "listed"
      : flow.sentTo !== null
        ? "code"
        : "number";

  // After the first step, each one puts the caret where the next keystroke
  // belongs. Never on arrival: a page does not grab the keyboard unasked.
  const arrived = useRef(false);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    if (mode === "phone") input.current?.focus({ preventScroll: true });
  }, [mode, step]);



  if (mode === "email") {
    return (
      <div className="tp-email">
        <ThemeProvider scheme="light">
          <JoinCard flow={email} ask={0} answered={answered} />
        </ThemeProvider>
      </div>
    );
  }

  if (step === "listed") {
    return (
      <div className="tp-in" role="status">
        <div className="tp-done">
          <span className="tp-tick" aria-hidden>
            <svg viewBox="0 0 14 14">
              <path d="M2.5 7.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <p className="tp-head">{flow.waitlist === "joined" ? JOINED_HEADING : ALREADY_HEADING}</p>
            <p className="tp-small" style={{ marginTop: 6 }}>
              {LISTED_NEXT}
            </p>
            <p className="tp-small" style={{ marginTop: 10 }}>
              <button type="button" className="tp-link" onClick={flow.changeNumber}>
                Use a different number
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const error = flow.error ? (
    <p className="tp-err" role="alert">
      {flow.error}
    </p>
  ) : null;

  if (step === "code") {
    return (
      <form
        className="tp-in"
        onSubmit={(event) => {
          event.preventDefault();
          if (!flow.submitting) void flow.verify();
        }}
      >
        <label className="tp-label" htmlFor="tp-code">
          Check your texts
        </label>
        <p className="tp-small" style={{ marginTop: -6 }}>
          We sent a {OTP_LENGTH}-digit code to {flow.sentTo}.
        </p>
        <div className="tp-row">
          <span className="tp-field tp-code" data-bad={flow.error ? "" : undefined}>
            <input
              id="tp-code"
              ref={input}
              value={flow.code}
              onChange={(event) => {
                const value = event.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH);
                flow.setCode(value);
                if (value.length === OTP_LENGTH && !flow.submitting) void flow.verify(value);
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={OTP_LENGTH}
              placeholder={`${OTP_LENGTH}-digit code`}
              disabled={flow.submitting}
              aria-invalid={flow.error ? true : undefined}
            />
          </span>
          <button type="submit" className="tp-go" disabled={flow.submitting}>
            Sign in
          </button>
        </div>
        {error}
        {flow.resent ? (
          <p className="tp-small" role="status">
            A new code is on its way. The last one no longer works.
          </p>
        ) : null}
        <p className="tp-small">
          <button type="button" className="tp-link" onClick={() => void flow.send(true)}>
            Text a new code
          </button>
          {" · "}
          <button type="button" className="tp-link" onClick={flow.changeNumber}>
            Use a different number
          </button>
        </p>
      </form>
    );
  }

  return (
    <form
      className="tp-in"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed.trim() !== "" && !flow.submitting) void flow.send();
      }}
    >
      <label className="tp-label" htmlFor="tp-phone">
        Join the waitlist
      </label>
      <div className="tp-row">
        <span className="tp-field" data-bad={flow.error ? "" : undefined}>
          <span className="tp-cc">
            +{country.dial} {CHEVRON}
            <select
              aria-label={`Country: ${country.name}`}
              value={country.iso}
              onChange={(event) => {
                const next = countryByIso(event.target.value);
                setCountry(next);
                flow.setPhone(composePhone(next, typed));
                input.current?.focus();
              }}
            >
              {PHONE_COUNTRIES.map((c) => (
                <option key={c.iso} value={c.iso}>
                  {c.name} +{c.dial}
                </option>
              ))}
            </select>
          </span>
          <input
            id="tp-phone"
            ref={input}
            value={typed}
            onChange={(event) => {
              const text = event.target.value;
              // A number pasted or autofilled with its own + carries its country.
              const own = countryOfNumber(text);
              if (own !== null) setCountry(own);
              setTyped(text);
              flow.setPhone(composePhone(own ?? country, text));
            }}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Your phone number"
            aria-describedby="tp-phone-why"
            disabled={flow.submitting}
            aria-invalid={flow.error ? true : undefined}
          />
        </span>
        <button type="submit" className="tp-go" disabled={flow.submitting}>
          Join the waitlist
        </button>
      </div>
      {error}
      <p className="tp-small" id="tp-phone-why">
        Invite only for now. When you're in, we'll text you Tex's number. Already in? We'll text you a code.{" "}
        <button type="button" className="tp-link" onClick={() => setMode("email")}>
          Use email instead
        </button>
      </p>
    </form>
  );
}
