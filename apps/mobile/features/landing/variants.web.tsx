import { useWindowDimensions } from "react-native";
import { LandingMap } from "./LandingMap";
import { LandingSignUp } from "./LandingSignUp";
import { Footer, Nav, Statement } from "./parts.web";

/**
 * The landing pages (Dev, 2026-10-11: "a more simple design … similar to
 * thebrowser.company and instinct.com"). One statement, a few lines, one
 * action: a is just that, b sets it beside the map. Every claim on them is
 * true of the product today, and the map's people, AIs and notes are a
 * labelled demo.
 */

/** The AIs that connect today, set a shade darker than the sentence round them. */
function Tools() {
  return (
    <>
      <b>Claude</b>, <b>ChatGPT</b>, <b>Codex</b>, <b>Cursor</b> and <b>Gemini&nbsp;CLI</b>
    </>
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
    <div className="lp-page">
      <Nav />
      <main className="lp-a">
        <Statement last="use">Context is one set of notes for you, your team, and every AI you</Statement>
        <div className="lp-a-row">
          <p className="lp-lede">
            <Tools /> connect with one sign‑in. A private note stays private, from people and from AIs. Text it in iMessage to
            ask or save something, and download everything, any time.
          </p>
          <SignUpCard />
        </div>
      </main>
      <Footer />
    </div>
  );
}

export function PageB() {
  // On a wide window the copy takes the left; the camera fits the rest.
  const width = useWindowDimensions().width;
  const wide = width > 900;
  const left = wide ? Math.min(600, width * 0.42) : 0;
  return (
    <div className="lp-page">
      <Nav />
      <main className="lp-b">
        <div className="lp-b-map">
          <LandingMap paper inset={wide ? { top: 40, right: 24, bottom: 40, left } : { top: 72, right: 0, bottom: 0, left: 0 }} />
        </div>
        <span className="lp-demo lp-b-label">Demo: made-up people, AIs and notes</span>
        <div className="lp-b-copy">
          <Statement last="page">Your team and its AIs, on the same</Statement>
          <p className="lp-lede">
            One set of notes for you, your team, and <Tools />. The map is everyone at work in it: who is in which note, and
            what each AI is reading.
          </p>
          <SignUpCard />
        </div>
      </main>
      <Footer />
    </div>
  );
}
