import { useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { OTP_LENGTH } from "../../auth/CodeBoxes";
import { landAfterSignIn } from "../../auth/landing";
import {
  PHONE_COUNTRIES,
  composePhone,
  countryByIso,
  countryOfNumber,
  DEFAULT_COUNTRY_ISO,
  type PhoneCountry,
} from "../../auth/phoneCountries";
import { usePhoneSignIn } from "../../auth/usePhoneSignIn";
import { texJoinError } from "./joinError";
import { readReceipt } from "./receipt";
import { TEXT_ROUTE, WAITLIST_ROUTE } from "./routes";

/**
 * tex.lc's sign-up, drawn twice on the landing page (the hero and the
 * closing section). The rules are the sign-in page's (`usePhoneSignIn`,
 * `phoneSignIn.start` on the server):
 *
 *  - a number not let in joins the list at once, and the page moves to
 *    `/waitlist`, "You're on the list", where the optional question is asked
 *    afterwards, never before;
 *  - a number already on the list is told so in place, and goes to
 *    `/waitlist` only when this browser holds that row's receipt;
 *  - a number that is let in, or has an account, is texted a code here, and
 *    the code signs in on tex.lc and opens `/text`, "Text Tex." with the
 *    console a button under it (Dev2, 2026-10-20), never the console itself;
 *  - somebody already signed in is not asked for a number at all: the slot
 *    says who they are signed in as and goes to `/text`.
 *
 * There is no email fallback: Tex is iMessage only, so a phone is the point.
 */
const CHEVRON = (
  <svg viewBox="0 0 10 10" aria-hidden>
    <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
  </svg>
);

export function TexJoin({ id, labelled = true }: { id: string; labelled?: boolean }) {
  const { isAuthenticated } = useConvexAuth();
  return isAuthenticated ? <SignedIn /> : <JoinForm id={id} labelled={labelled} />;
}

function SignedIn() {
  const home = useQuery(api.functions.texHome.mine, {});
  const ending = home?.ending ?? null;
  return (
    <div className="tx-signed">
      <p className="tx-who" role="status">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        {ending === null ? (
          <span>You're signed in.</span>
        ) : (
          <span>
            You're signed in as <strong aria-label={`your number ending in ${ending}`}>•••• {ending}</strong>.
          </span>
        )}
      </p>
      <a className="tx-btn" href={TEXT_ROUTE}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
        </svg>
        Text Tex
      </a>
    </div>
  );
}

function JoinForm({ id, labelled }: { id: string; labelled: boolean }) {
  const router = useRouter();
  const [unavailable, setUnavailable] = useState(false);
  const flow = usePhoneSignIn({
    onSignedIn: () => landAfterSignIn(TEXT_ROUTE, (href) => router.replace(href as never)),
    onUnavailable: () => setUnavailable(true),
  });
  const [country, setCountry] = useState<PhoneCountry>(() => countryByIso(DEFAULT_COUNTRY_ISO));
  const [typed, setTyped] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const step = flow.waitlist !== null ? "listed" : flow.sentTo !== null ? "code" : "number";

  // Joined, or already listed from this very browser: the status page.
  const goStatus = flow.waitlist === "joined" || (flow.waitlist === "already" && readReceipt() !== null);
  useEffect(() => {
    if (goStatus) router.push(WAITLIST_ROUTE as never);
  }, [goStatus, router]);

  const arrived = useRef(false);
  useEffect(() => {
    if (!arrived.current) {
      arrived.current = true;
      return;
    }
    input.current?.focus({ preventScroll: true });
  }, [step]);

  // `flow.error` clears as soon as the number is edited; the status says which words.
  const error = texJoinError(unavailable ? "unavailable" : flow.error === null ? null : flow.startStatus);
  const errorLine = error ? (
    <p className="tx-err" role="alert">
      {error}
    </p>
  ) : null;

  if (step === "listed") {
    if (goStatus) return <p className="tx-small" role="status">You're on the list.</p>;
    return (
      <div className="tx-join" role="status">
        <div className="tx-done">
          <div>
            <p className="tx-head-line">You're already on the list.</p>
            <p className="tx-small">We'll text you Tex's number when it's your turn. There's nothing else to do.</p>
            <p className="tx-small">
              <button type="button" className="tx-link" onClick={flow.changeNumber}>
                Use a different number
              </button>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (step === "code") {
    return (
      <form
        className="tx-join"
        onSubmit={(event) => {
          event.preventDefault();
          if (!flow.submitting) void flow.verify();
        }}
      >
        <label className="tx-label" htmlFor={`${id}-code`}>
          You're in. Check your texts
        </label>
        <p className="tx-small">
          We sent a {OTP_LENGTH}-digit code to {flow.sentTo}. It signs you in here.
        </p>
        <div className="tx-row">
          <span className="tx-field tx-code" data-bad={flow.error ? "" : undefined}>
            <input
              id={`${id}-code`}
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
          <button type="submit" className="tx-btn" disabled={flow.submitting}>
            Sign in
          </button>
        </div>
        {flow.error ? (
          <p className="tx-err" role="alert">
            {flow.error.replace(", or use email instead", "")}
          </p>
        ) : null}
        <p className="tx-small">
          <button type="button" className="tx-link" onClick={() => void flow.send(true)}>
            Text a new code
          </button>
          {" · "}
          <button type="button" className="tx-link" onClick={flow.changeNumber}>
            Use a different number
          </button>
        </p>
      </form>
    );
  }

  return (
    <form
      className="tx-join"
      onSubmit={(event) => {
        event.preventDefault();
        setUnavailable(false);
        if (typed.trim() !== "" && !flow.submitting) void flow.send();
      }}
    >
      <label className={labelled ? "tx-label" : "tx-sr"} htmlFor={`${id}-phone`}>
        Get on the list <span>· iMessage only</span>
      </label>
      <div className="tx-row">
        <span className="tx-field" data-bad={error ? "" : undefined}>
          <span className="tx-cc">
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
          <span className="tx-sep" aria-hidden />
          <input
            id={`${id}-phone`}
            ref={input}
            value={typed}
            onChange={(event) => {
              const text = event.target.value;
              const own = countryOfNumber(text);
              if (own !== null) setCountry(own);
              setTyped(text);
              flow.setPhone(composePhone(own ?? country, text));
            }}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Your phone number"
            disabled={flow.submitting}
            aria-invalid={error ? true : undefined}
          />
        </span>
        <button type="submit" className="tx-btn" disabled={flow.submitting}>
          Join
        </button>
      </div>
      {errorLine}
    </form>
  );
}
