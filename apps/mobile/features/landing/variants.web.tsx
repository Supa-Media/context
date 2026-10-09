import { useEffect, useState } from "react";
import { useWindowDimensions } from "react-native";
import { useReducedMotion } from "../design/useReducedMotion";
import { DEMO_IDS, demoCounts } from "./demoMap";
import { LandingMap } from "./LandingMap";
import { Footer, Headline, JoinLink, Nav } from "./parts.web";
import { LandingSignUp } from "./LandingSignUp";

/**
 * The five versions (Dev2, 2026-10-09). a is tab.bot's shape in our colours,
 * b puts the map behind everything, c sets the copy beside it, d sets it
 * centre stage, and e leads with texting. Every claim on them is true of the
 * product today, and the map's people, AIs and notes are a labelled demo.
 */

const STATEMENT = "Context is one set of notes for you, your team, and every AI you use.";
const LEDE = "One set of notes for you, your team, and every AI you use.";

const PROSE = [
  "Most AI starts from zero. You explain the project again, paste in the same notes, and then copy the answer somewhere your team will see it.",
  "Context keeps your notes in one place that you, your team and your AI tools all use. Claude, ChatGPT, Codex, Cursor and Gemini CLI connect with one sign‑in. They can find and read the notes you can see, and write back where your role allows.",
  "Every workspace has its own people and its own privacy. A private note stays private, from people and from AIs: an assistant can't read a note you can't, or write somewhere you can't.",
  "Every note is a plain Markdown file. We run the storage for free up to 1,000 notes, or you can plug in your own. Either way you can download everything, any time, on every plan.",
  "And you can watch it happen. The map shows who is in which note, what each AI is reading, and what changed today.",
];

/** The statement and the prose under it: what Context is, in the order a stranger needs it. */
function Story() {
  return (
    <>
      <p className="lp-stmt">{STATEMENT}</p>
      <div className="lp-prose">
        {PROSE.map((line) => (
          <p key={line.slice(0, 24)}>{line}</p>
        ))}
      </div>
    </>
  );
}

/** The sign-up, at the foot of a page whose hero has none. */
function JoinSection() {
  return (
    <section className="lp-join" id="join" aria-labelledby="lp-join-title">
      <div className="lp-glow" />
      <Headline as="h2">
        <span id="lp-join-title">Get on the same page</span>
      </Headline>
      <p>We're letting people in a few at a time.</p>
      <div className="lp-card">
        <LandingSignUp />
      </div>
    </section>
  );
}

/** The foot of a page whose hero has the sign-up: one more way back to it. */
function Closing() {
  return (
    <section className="lp-cta">
      <Headline as="h2">Get on the same page</Headline>
      <JoinLink dark />
    </section>
  );
}

function DemoNote() {
  const { people, agents } = demoCounts();
  return (
    <span className="lp-live">
      <i />
      {people} people and {agents} AIs at work · demo
    </span>
  );
}

function SignUpCard() {
  return (
    <div className="lp-card" id="join">
      <LandingSignUp />
    </div>
  );
}

export function PageA() {
  return (
    <>
      <header className="lp-a-hero">
        <Nav />
        <div className="lp-map lp-fade">
          <LandingMap paper inset={{ top: 60, right: 0, bottom: 220, left: 0 }} />
        </div>
        <div className="lp-a-line">
          <Headline />
          <JoinLink />
        </div>
        <div className="lp-hint">
          <span>Scroll to explore</span>
          <i />
          <span className="lp-demo">Demo workspaces</span>
        </div>
      </header>
      <Story />
      <JoinSection />
      <Footer />
    </>
  );
}

export function PageB() {
  // On a wide window the copy card covers the left; the camera fits the rest.
  const width = useWindowDimensions().width;
  const left = width > 600 ? Math.min(680, width * 0.45) : 0;
  return (
    <>
      <header className="lp-b-hero">
        <Nav cta={false} />
        <div className="lp-map">
          <LandingMap paper inset={{ top: 80, right: 0, bottom: 0, left }} />
        </div>
        <div className="lp-b-copy lp-card">
          <Headline />
          <p className="lp-lede">{LEDE}</p>
          <div id="join">
            <LandingSignUp />
          </div>
          <span className="lp-demo">The map is a demo: made-up people, AIs and notes.</span>
        </div>
      </header>
      <Story />
      <Closing />
      <Footer />
    </>
  );
}

export function PageC() {
  return (
    <>
      <Nav cta={false} />
      <header className="lp-c-hero">
        <div className="lp-c-copy">
          <Headline />
          <p className="lp-lede">
            Finally, everyone's on the same page. You, your team, Claude, ChatGPT and Codex read and write the same notes.
          </p>
          <SignUpCard />
        </div>
        <Window className="lp-c-win" title="Map · All workspaces · demo" />
      </header>
      <Story />
      <Closing />
      <Footer />
    </>
  );
}

export function PageD() {
  return (
    <>
      <Nav cta={false} />
      <header className="lp-d-hero">
        <DemoNote />
        <Headline />
        <p className="lp-lede">{LEDE}</p>
        <SignUpCard />
      </header>
      <Window className="lp-d-win" title="Map · All workspaces · demo" />
      <Story />
      <Closing />
      <Footer />
    </>
  );
}

/** A plain window round the map: a title bar, then the map filling the rest. */
function Window({ className, title, only }: { className: string; title: string; only?: string }) {
  return (
    <div className={`lp-window ${className}`}>
      <div className="lp-bar">
        <i />
        <i />
        <i />
        <span>{title}</span>
      </div>
      <div className="lp-stage">
        <LandingMap only={only} />
      </div>
    </div>
  );
}

/** The texting assistant's thread, a message at a time. */
const THREAD: readonly { me: boolean; text: string }[] = [
  { me: true, text: "what did we decide about pricing?" },
  { me: false, text: "$5 a month per workspace, for early users. It's in Northwind › Projects › Pricing." },
  { me: true, text: "remember the dentist is tuesday at 3" },
  { me: false, text: "Saved to your notes." },
  { me: true, text: "every monday at 9 text me my open projects" },
  { me: false, text: "Done. You'll get them every Monday at 9." },
];

function Messages() {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? THREAD.length : 0);
  useEffect(() => {
    if (reduced) {
      setShown(THREAD.length);
      return;
    }
    // One message every 1.8 s, a pause on the full thread, then again.
    const id = setInterval(() => setShown((n) => (n >= THREAD.length + 3 ? 0 : n + 1)), 1800);
    return () => clearInterval(id);
  }, [reduced]);
  return (
    <div className="lp-phone" aria-label="A text conversation with Context" role="img">
      <div className="lp-scr">
        <div className="lp-mh">
          <span className="lp-av" />
          <span>Context ›</span>
        </div>
        <div className="lp-ms">
          {THREAD.slice(0, Math.min(shown, THREAD.length)).map((m) => (
            <div key={m.text} className={m.me ? "lp-b lp-me" : "lp-b lp-it"}>
              {m.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const FACTS = [
  { q: "what's on for friday?", title: "Answers from your notes", body: "It looks in the notes you can see and answers right in the thread." },
  { q: "remember Ana's birthday is May 4", title: "Saves what you send", body: "Tell it something and it writes it into your notes, where every AI you connect can read it." },
  { q: "text me my tasks at 8", title: "Texts you on a schedule", body: "Ask for a routine and it writes one into your notes, then texts you when it runs." },
];

export function PageE() {
  return (
    <>
      <Nav cta={false} />
      <header className="lp-e-hero">
        <div className="lp-e-copy">
          <span className="lp-imsg">
            <i />
            In iMessage
          </span>
          <Headline>Just text it</Headline>
          <p className="lp-lede">
            Ask about anything in your notes, or tell it what to remember. Context answers in Messages, and your whole team's AIs see the same notes.
          </p>
          <SignUpCard />
        </div>
        <Messages />
      </header>
      <section className="lp-sec">
        <Headline as="h2">Behind the messages are your notes</Headline>
        <div className="lp-mapcard">
          <LandingMap paper only={DEMO_IDS.personal} />
        </div>
        <span className="lp-demo">A demo workspace: made-up people, AIs and notes.</span>
        <div className="lp-facts">
          {FACTS.map((f) => (
            <div className="lp-fact" key={f.title}>
              <span className="lp-q">{f.q}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>
      <Closing />
      <Footer />
    </>
  );
}
