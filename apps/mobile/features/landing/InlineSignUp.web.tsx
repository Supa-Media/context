import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "expo-router";
import { useHomeJoin } from "../auth/JoinCard";
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
import type { EmailSignIn } from "../auth/useEmailSignIn";

/**
 * The landing sign-up (`NotesPage.web`, styled by `signUpCss.ts`): a labelled
 * email field and a button that says what it does. Email leads because
 * context.lc markets Context and tex.lc markets Tex, which is the texting one
 * (Dev2, 2026-10-28: "change the main signup to email here instead of phone
 * number - we are suppose to be marketing context and tex separately"). The
 * rules are the sign-in page's (`useEmailSignIn`): an address not let in
 * joins the waitlist in place, one that is in is emailed a code, and each
 * later step is drawn in the same place. Somebody who signs in with their
 * phone can switch to the texted code (`usePhoneSignIn`), the sign-up that led
 * here from 2026-10-12 to 2026-10-28.
 */
const CHEVRON = (
  <svg viewBox="0 0 10 10" aria-hidden>
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </svg>
);

/** What happens next for a phone on the list: the "You're in" text names Tex (`waitlistText.ts`). */
export const LISTED_NEXT = "When you're let in, we'll text you Tex's number. Text it hello and Tex sets you up.";

/** What the first line says under the field. */
export const EMAIL_WHY = "Invite only for now. We're letting people in a few at a time. Already in? We'll email you a code.";

export function InlineSignUp() {
  const [mode, setMode] = useState<"phone" | "email">("email");
  const router = useRouter();
  const replace = (href: string) => router.replace(href as never);
  const email = useHomeJoin({ replace });
  return mode === "email" ? (
    <EmailLine flow={email} onPhone={() => setMode("phone")} />
  ) : (
    <PhoneLine replace={replace} onEmail={() => setMode("email")} />
  );
}

/** A tick, a heading and what happens next: the line once somebody is on the list. */
function Listed({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="tp-in" role="status">
      <div className="tp-done">
        <span className="tp-tick" aria-hidden>
          <svg viewBox="0 0 14 14">
            <path d="M2.5 7.4l3 3 6-6.6" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div>
          <p className="tp-head">{heading}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function EmailLine({ flow, onPhone }: { flow: EmailSignIn; onPhone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [useFor, setUseFor] = useState("");

  // After the first step, each one puts the caret where the next keystroke
  // belongs, once the field is no longer disabled by the send. Never on
  // arrival: a page does not grab the keyboard unasked.
  const arrived = useRef(false);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    if (!flow.submitting) input.current?.focus({ preventScroll: true });
  }, [flow.step, flow.submitting]);

  const error = flow.error ? (
    <p className="tp-err" role="alert">
      {flow.error}
    </p>
  ) : null;

  if (flow.step === "joined" || flow.step === "already") {
    const joined = flow.step === "joined";
    return (
      <Listed heading={joined ? JOINED_HEADING : ALREADY_HEADING}>
        <p className="tp-small" style={{ marginTop: 6 }}>
          We'll email <b>{flow.email.trim()}</b> when it's your turn.
        </p>
        {joined && !flow.described ? (
          <form
            className="tp-row tp-ask"
            onSubmit={(event) => {
              event.preventDefault();
              void flow.sendUseFor(useFor);
            }}
          >
            <span className="tp-field">
              <input
                ref={input}
                value={useFor}
                onChange={(event) => setUseFor(event.target.value)}
                maxLength={280}
                placeholder="What would you use it for? (optional)"
                aria-label="What would you use it for? (optional)"
              />
            </span>
            <button type="submit" className="tp-go" disabled={useFor.trim() === ""}>
              Send
            </button>
          </form>
        ) : null}
        {joined && flow.described ? (
          <p className="tp-small" style={{ marginTop: 10 }}>
            Thanks, that helps.
          </p>
        ) : null}
        <p className="tp-small" style={{ marginTop: 10 }}>
          <button type="button" className="tp-link" onClick={flow.changeEmail}>
            Use a different email
          </button>
        </p>
      </Listed>
    );
  }

  if (flow.step === "verify") {
    return (
      <form
        className="tp-in"
        onSubmit={(event) => {
          event.preventDefault();
          if (!flow.submitting) void flow.verify();
        }}
      >
        <label className="tp-label" htmlFor="tp-code">
          Check your email
        </label>
        <p className="tp-small" style={{ marginTop: -6 }}>
          We sent a {OTP_LENGTH}-digit code to {flow.email.trim()}.
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
          <button type="button" className="tp-link" onClick={() => void flow.resend()}>
            Email a new code
          </button>
          {" · "}
          <button type="button" className="tp-link" onClick={flow.changeEmail}>
            Use a different email
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
        if (flow.canSubmit && !flow.submitting) void flow.submitEmail();
      }}
    >
      <label className="tp-label" htmlFor="tp-email">
        Join the waitlist
      </label>
      <div className="tp-row">
        <span className="tp-field" data-bad={flow.error ? "" : undefined}>
          <input
            id="tp-email"
            ref={input}
            value={flow.email}
            onChange={(event) => flow.setEmail(event.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Your email"
            aria-describedby="tp-email-why"
            disabled={flow.submitting}
            aria-invalid={flow.error ? true : undefined}
          />
        </span>
        <button type="submit" className="tp-go" disabled={flow.submitting}>
          Join the waitlist
        </button>
      </div>
      {error}
      <p className="tp-small" id="tp-email-why">
        {EMAIL_WHY}{" "}
        <button type="button" className="tp-link" onClick={onPhone}>
          Sign in with your phone
        </button>
      </p>
    </form>
  );
}

/** The texted-code line, for somebody who signs in with their phone. */
function PhoneLine({ replace, onEmail }: { replace: (href: string) => void; onEmail: () => void }) {
  const flow = usePhoneSignIn({
    onSignedIn: () => landAfterSignIn(CONSOLE_ROUTE, replace),
    onUnavailable: onEmail,
  });
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

  // This line is only ever drawn because somebody asked for it, so the caret
  // goes in at once, and then wherever each later step needs the next keystroke.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [step]);

  if (step === "listed") {
    return (
      <Listed heading={flow.waitlist === "joined" ? JOINED_HEADING : ALREADY_HEADING}>
        <p className="tp-small" style={{ marginTop: 6 }}>
          {LISTED_NEXT}
        </p>
        <p className="tp-small" style={{ marginTop: 10 }}>
          <button type="button" className="tp-link" onClick={flow.changeNumber}>
            Use a different number
          </button>
        </p>
      </Listed>
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
        Sign in with your phone
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
          Text me a code
        </button>
      </div>
      {error}
      <p className="tp-small" id="tp-phone-why">
        We'll text you a code. A number we don't know yet joins the waitlist.{" "}
        <button type="button" className="tp-link" onClick={onEmail}>
          Use email instead
        </button>
      </p>
    </form>
  );
}
