import { trackEvent } from "../../observability/client";
import { useEffect } from "react";
import { useConvexAuth } from "convex/react";
import { Tex } from "../../chaos/Tex";
import { captureLanding } from "../../auth/landingPage";
import { CONSOLE_ROUTE, LOGIN_ROUTE } from "../../auth/redirect";
import { readReceipt } from "./receipt";
import { TEXT_ROUTE, WAITLIST_ROUTE } from "./routes";
import { TexJoin } from "./TexJoin.web";
import { TEX_LAUNCH_CSS } from "./texLaunchCss";

/**
 * tex.lc's `/`: "A personal assistant you just text." Direction A of the Tex
 * landing artboard, chosen by Seyi on 2026-10-19, drawn as approved: the hero
 * with the sign-up and one conversation, what Tex does, a day with Tex, how it
 * works, "your notes stay yours", questions, and the sign-up again.
 *
 * Every claim on it is something Tex does today (iMessage only, asks before an
 * email or a calendar change, at most three check-ins a day). The
 * conversations are written examples and say so. context.lc keeps its own
 * landing; this is drawn only on a Tex host (`isTexHost`).
 */
export const TEX_TITLE = "Tex: a personal assistant you just text";

export function TexMark({ className = "tx-mark" }: { className?: string }) {
  return (
    <span className={className} aria-hidden>
      <Tex chaos={0} scheme="light" />
    </span>
  );
}

export function TexHeader({ right }: { right: React.ReactNode }) {
  return (
    <header className="tx-wrap tx-head">
      <a className="tx-brand" href="/" aria-label="tex.lc home">
        <TexMark />
        <span className="tx-word">
          tex<b>.lc</b>
        </span>
      </a>
      {right}
    </header>
  );
}

export function TexFooter() {
  return (
    <footer className="tx-wrap tx-foot">
      <span>
        Tex, from{" "}
        <span className="tx-ctx">
          Context<b>.</b>
        </span>{" "}
        Your notes stay yours.
      </span>
      <nav aria-label="About">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="https://context.lc">About Context</a>
      </nav>
    </footer>
  );
}

function useTexTitle() {
  useEffect(() => {
    const title = document.title;
    document.title = TEX_TITLE;
    return () => {
      document.title = title;
    };
  }, []);
}

export function TexLanding() {
  useTexTitle();
  useEffect(() => {
    // The waitlist row records which page it was joined from.
    captureLanding("tex");
  }, []);
  // A browser holding a place in line is shown the way back to it; somebody
  // signed in, the console. Signing in here comes back to `/text`.
  const listed = readReceipt() !== null;
  const { isAuthenticated: signedIn } = useConvexAuth();
  const signIn = `${LOGIN_ROUTE}?next=${encodeURIComponent(TEXT_ROUTE)}`;
  return (
    <div className="tx" data-landing="tex">
      <style>{TEX_LAUNCH_CSS}</style>
      <TexHeader
        right={
          <a className="tx-pill" data-analytics-action="header" onClick={() => trackEvent("landing_cta_clicked", { action: signedIn ? "console" : listed ? "waitlist" : "sign_in", placement: "header" })} href={signedIn ? CONSOLE_ROUTE : listed ? WAITLIST_ROUTE : signIn}>
            {signedIn ? "Open console" : listed ? "Your spot" : "Sign in"}
          </a>
        }
      />

      <main className="tx-wrap tx-hero">
        <section className="tx-words">
          <h1 className="tx-h1">A personal assistant you just text.</h1>
          <p className="tx-lede">
            Tex keeps track of what you tell it, looks things up, puts plans on your calendar and reminds you when it
            matters. It always asks before it sends an email or changes your calendar.
          </p>
          <TexJoin id="tx-hero" />
          {signedIn ? null : (
            <p className="tx-small tx-after">
              Invite only for now. We'll text you when it's your turn. Already let in? <a className="tx-link" href={signIn}>Sign in</a>.
            </p>
          )}
        </section>
        <section className="tx-chat" aria-label="An example conversation with Tex">
          <div className="tx-chat-top">
            <span className="tx-av">
              <Tex chaos={0} size={30} scheme="light" />
            </span>
            <span className="tx-name">Tex</span>
          </div>
          <div className="tx-log">
            <p className="tx-me">the plumber is coming thursday between 9 and 12</p>
            <p className="tx-tex">Want me to put Thursday 9 to 12 on your calendar?</p>
            <p className="tx-me">yes</p>
            <p className="tx-tex">Added. I'll remind you Wednesday night to clear under the sink.</p>
            <p className="tx-me">gift ideas for my sister under $50? she's into pottery</p>
            <p className="tx-tex">
              Three good ones: a glaze sampler set, a one-night wheel class, or a mug from a local studio. I saved them in
              your Gift ideas note.
            </p>
          </div>
        </section>
      </main>

      <section className="tx-wrap tx-section" aria-label="What Tex does">
        <h2 className="tx-h2">The small stuff, handled the way you'd want.</h2>
        <div className="tx-cards">
          <Card title="Writes it down" icon={<><path d="M4 4h12l4 4v12H4z" /><path d="M8 4v5h7" /><path d="M8 14h8M8 18h5" /></>}>
            Every bill, name and plan lands in your notes, in plain files you can open and edit any time.
          </Card>
          <Card title="Looks into it" icon={<><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>}>
            A flight, a store's hours, the page you sent it. Tex reads it and texts back the part that matters.
          </Card>
          <Card title="Takes care of it, after you say yes" icon={<path d="M4 12.5 9 17l11-11" />}>
            Emails and calendar changes are drafted first. Nothing goes out until you text "yes".
          </Card>
          <Card title="Checks in, lightly" icon={<><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></>}>
            A few short check-ins a day, never more than three, only when something needs you.
          </Card>
        </div>
      </section>

      <section className="tx-wrap tx-section tx-day" aria-label="A day with Tex">
        <div className="tx-day-words">
          <span className="tx-eyebrow">A Tuesday with Tex</span>
          <h2 className="tx-h2">Text it like you'd text a friend. Tex does the rest.</h2>
          <p className="tx-lede">
            Send the thought as it comes: a photo of a bill, a voice note from the car, half a sentence. Tex writes it
            down, looks into it, and asks before it sends anything on your behalf.
          </p>
          <p className="tx-small">Example conversation. Names are made up.</p>
        </div>
        <div className="tx-day-chat">
          <div className="tx-day-top">
            <span className="tx-av">
              <Tex chaos={0} size={22} scheme="light" />
            </span>
            <span className="tx-strong">Tex</span>
            <span className="tx-small tx-day-via">
              iMessage
            </span>
          </div>
          <span className="tx-time">8:12 AM</span>
          <p className="tx-me">mom lands sat around 2, delta 1424. remind me to leave early</p>
          <p className="tx-tex">
            Noted. I looked it up: Delta 1424 is due in at 2:05, Terminal 4. I'll text you at 12:45 to head out. Put the
            pickup on your calendar?
          </p>
          <p className="tx-me">yes</p>
          <p className="tx-tex">Added: Saturday 2:05 PM, "Pick up Mom, Terminal 4."</p>
          <span className="tx-time">12:40 PM</span>
          <div className="tx-photo" role="img" aria-label="Photo of a dentist bill">
            photo: dentist bill
          </div>
          <p className="tx-me">ugh</p>
          <p className="tx-tex">$140 to Dr. Patel, due the 28th. I put it in your bills note. Remind you Monday at 9?</p>
          <p className="tx-me">ya. and tell coach ines can't make sat practice</p>
          <p className="tx-tex">
            Here's the email to Coach Ramirez: "Hi Coach, Ines will miss Saturday's practice, family in town. See you
            Tuesday." Send it?
          </p>
          <p className="tx-me">send</p>
          <p className="tx-tex">Sent.</p>
          <span className="tx-time">6:00 PM · check-in</span>
          <p className="tx-tex">
            Before the evening: Saturday pickup is on your calendar, dentist reminder is set for Monday, Coach wrote back
            "No problem." Nothing else needs you today.
          </p>
        </div>
      </section>

      <section className="tx-wrap tx-section" aria-label="How it works">
        <h2 className="tx-h2">How it works</h2>
        <ol className="tx-steps">
          <Step n={1} title="Get on the list">
            Leave your number. This browser keeps your place, so you can come back any time to see where you stand.
          </Step>
          <Step n={2} title="When it's your turn, we text you Tex's number">
            Save the contact and send the first text. Tex works in iMessage, so there's no new app.
          </Step>
          <Step n={3} title="See what Tex knows, any time">
            Your notes live in Context, the notes app Tex comes from. Open them from tex.lc on your phone or computer.
          </Step>
        </ol>
      </section>

      <section className="tx-wrap" aria-label="Your notes stay yours">
        <div className="tx-trust">
          <TexMark />
          <div className="tx-trust-words">
            <h2 className="tx-h2">Your notes stay yours.</h2>
            <p className="tx-lede tx-trust-lede">
              Everything Tex knows about you is written in plain notes you can read, change or take with you. Tex asks
              before it shares anything, sends an email or touches your calendar. If you stop, your notes stay.
            </p>
          </div>
        </div>
      </section>

      <section className="tx-wrap tx-section tx-faq-wrap" aria-label="Questions">
        <h2 className="tx-h2">Good to know</h2>
        <dl className="tx-faq">
          <div>
            <dt>Does it work on Android?</dt>
            <dd>Tex is in iMessage today. If you text from another phone, Tex replies asking you to use iMessage.</dd>
          </div>
          <div>
            <dt>Can I send photos and voice notes?</dt>
            <dd>Yes. Photos, PDFs, documents and voice notes all work. Tex reads or listens, then writes down what mattered.</dd>
          </div>
          <div>
            <dt>Will it text me all day?</dt>
            <dd>No. Tex answers when you text, and checks in on its own at most three times a day. Tex never texts a stranger first.</dd>
          </div>
          <div>
            <dt>Where do my notes live?</dt>
            <dd>
              In Context, the notes app Tex comes from. They are plain files: open them, edit them, export them, share a
              folder with a friend or your family.
            </dd>
          </div>
        </dl>
      </section>

      <section className="tx-wrap tx-section tx-close" aria-label="Get on the list">
        <h2 className="tx-h2">Leave your number. We'll text you when it's your turn.</h2>
        <TexJoin id="tx-close" labelled={false} />
        {signedIn ? null : (
          <p className="tx-small">
            Invite only for now · iMessage only. Already let in? <a className="tx-link" href={signIn}>Sign in</a>.
          </p>
        )}
      </section>

      <TexFooter />
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <article className="tx-card">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {icon}
      </svg>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="tx-step">
      <span className="tx-num" aria-hidden>
        {n}
      </span>
      <div>
        <h3>{title}</h3>
        <p>{children}</p>
      </div>
    </li>
  );
}
