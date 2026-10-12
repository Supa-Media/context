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
import { ALREADY_HEADING, JOINED_HEADING, WAITLIST_WHY } from "../auth/phoneSignIn";
import { CONSOLE_ROUTE } from "../auth/redirect";
import { usePhoneSignIn } from "../auth/usePhoneSignIn";
import { ThemeProvider } from "../design/theme";

/**
 * Page a's sign-up, written into the line it starts from (Dev2, 2026-10-12:
 * "join the waitlist can be inline", board A of the inline boards). Pressing
 * "Join the waitlist" turns those words into an underlined number field in the
 * page's own type, with the › as its button; every later step (on the list,
 * the texted code, a problem) is drawn on the same line. The rules are the
 * sign-in page's (`usePhoneSignIn`): a number not let in joins the waitlist in
 * place, one that is in is texted a code. Email swaps in the homepage's email
 * card, the same fallback the old form had.
 */
export function InlineSignUp() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"phone" | "email">("phone");
  const router = useRouter();
  const replace = (href: string) => router.replace(href as never);
  const flow = usePhoneSignIn({
    onSignedIn: () => landAfterSignIn(CONSOLE_ROUTE, replace),
    onUnavailable: () => setMode("email"),
  });
  const email = useHomeJoin({ replace });
  const answered = useRef(0);
  const [country, setCountry] = useState<PhoneCountry>(() => countryByIso(DEFAULT_COUNTRY_ISO));
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const step = flow.waitlist !== null ? "listed" : flow.sentTo !== null ? "code" : "number";

  // Each step puts the caret where the next keystroke belongs.
  useEffect(() => {
    if (open && mode === "phone") input.current?.focus({ preventScroll: true });
  }, [open, mode, step]);

  if (!open) {
    return (
      <p className="sp-p">
        <button type="button" className="sp-cta" onClick={() => setOpen(true)}>
          <span>Join the waitlist</span> ›
        </button>
      </p>
    );
  }

  if (mode === "email") {
    return (
      <div className="sp-email">
        <ThemeProvider scheme="light">
          <JoinCard flow={email} ask={0} answered={answered} />
        </ThemeProvider>
      </div>
    );
  }

  if (step === "listed") {
    return (
      <div className="sp-in" role="status">
        <p className="sp-p">{flow.waitlist === "joined" ? JOINED_HEADING : ALREADY_HEADING}</p>
        <p className="sp-small">{WAITLIST_WHY}</p>
        <p className="sp-small">
          <button type="button" className="sp-link" onClick={flow.changeNumber}>
            Use a different number
          </button>
        </p>
      </div>
    );
  }

  const error = flow.error ? (
    <p className="sp-err" role="alert">
      {flow.error}
    </p>
  ) : null;

  if (step === "code") {
    return (
      <form
        className="sp-in"
        onSubmit={(event) => {
          event.preventDefault();
          if (!flow.submitting) void flow.verify();
        }}
      >
        <p className="sp-p">Check your texts.</p>
        <label className="sp-hint" htmlFor="sp-code">
          Code sent to {flow.sentTo}
        </label>
        <p className="sp-line">
          <input
            id="sp-code"
            ref={input}
            className="sp-field sp-code"
            data-bad={flow.error ? "" : undefined}
            value={flow.code}
            onChange={(event) => {
              const value = event.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH);
              flow.setCode(value);
              if (value.length === OTP_LENGTH && !flow.submitting) void flow.verify(value);
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={OTP_LENGTH}
            disabled={flow.submitting}
            aria-invalid={flow.error ? true : undefined}
          />
          <button type="submit" className="sp-go" aria-label="Sign in" disabled={flow.submitting}>
            ›
          </button>
        </p>
        {error}
        {flow.resent ? (
          <p className="sp-small" role="status">
            A new code is on its way. The last one no longer works.
          </p>
        ) : null}
        <p className="sp-small">
          <button type="button" className="sp-link" onClick={() => void flow.send(true)}>
            Text a new code
          </button>
          {" · "}
          <button type="button" className="sp-link" onClick={flow.changeNumber}>
            Use a different number
          </button>
        </p>
      </form>
    );
  }

  return (
    <form
      className="sp-in"
      onSubmit={(event) => {
        event.preventDefault();
        if (typed.trim() !== "" && !flow.submitting) void flow.send();
      }}
    >
      <label className="sp-hint" htmlFor="sp-phone">
        Your phone number
      </label>
      <p className="sp-line">
        <span className="sp-field" data-bad={flow.error ? "" : undefined}>
          <span className="sp-cc">
            +{country.dial} ▾
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
            id="sp-phone"
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
            disabled={flow.submitting}
            aria-invalid={flow.error ? true : undefined}
          />
        </span>
        <button type="submit" className="sp-go" aria-label="Join the waitlist" disabled={flow.submitting}>
          ›
        </button>
      </p>
      {error}
      <p className="sp-small">
        Invite only for now. Already in? We'll text you a code.
        <br />
        No phone?{" "}
        <button type="button" className="sp-link" onClick={() => setMode("email")}>
          Use email instead
        </button>
      </p>
    </form>
  );
}
