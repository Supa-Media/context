import { LandingEditor } from "./LandingEditor";
import { LandingMap } from "./LandingMap";
import { Footer, Headline, JoinLink, Nav } from "./parts.web";
import { LandingSignUp } from "./LandingSignUp";

/**
 * Page b, the landing page `/` showed from 2026-10-09 to 2026-10-11 (then
 * page a of five), kept as it was (Dev, 2026-10-11: "b/ should be the current
 * default page"): tab.bot's shape in our colours, with the map at the centre.
 * Every claim on it is true of the product today, and the map's people, AIs
 * and notes are a labelled demo.
 */

const STATEMENT = "Context is one set of notes for you, your team, and every AI you use.";

const PROSE = [
  "Most AI starts from zero. You explain the project again, paste in the same notes, and then copy the answer somewhere your team will see it.",
  "Context keeps your notes in one place that you, your team and your AI tools all use. Claude, ChatGPT, Codex, Cursor and Gemini CLI connect with one sign‑in. They can find and read the notes you can see, and write back where your role allows.",
  "Every workspace has its own people and its own privacy. A private note stays private, from people and from AIs: an assistant can't read a note you can't, or write somewhere you can't.",
  "Every note is a plain Markdown file. We run the storage for you, or you can plug in your own. Either way you can download everything, any time, for free.",
  "And you can watch it happen. The map shows who is in which note, what each AI is reading, and what changed today.",
];

/** What page a's editor section says beside the editor: each one true today. */
const EDITOR_POINTS = [
  "Plain Markdown files, no clutter",
  "Claude, ChatGPT, Codex, Cursor and Gemini CLI connect to it",
  "Your files, yours to download or move any time",
  "Write together, live, with people and AIs",
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

export function PageB() {
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
      <section className="lp-a-editor" aria-labelledby="lp-editor-title">
        <h2 id="lp-editor-title">A Markdown editor, and nothing in the way.</h2>
        <ul className="lp-points">
          {EDITOR_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        <LandingEditor />
        <p className="lp-demo">The real editor, playing a demo: made-up people and AIs writing in one note.</p>
      </section>
      <Story />
      <JoinSection />
      <Footer />
    </>
  );
}
