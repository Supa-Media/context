import { useWindowDimensions } from "react-native";
import { Doodles } from "./Doodles.web";
import { DEMO_IDS } from "./demoMap";
import { LandingMap } from "./LandingMap";
import { LandingSignUp } from "./LandingSignUp";
import { Footer, Nav } from "./parts.web";
import { Tell } from "./Tell.web";

/**
 * The landing pages (Dev, 2026-10-11: "a more simple design … similar to
 * thebrowser.company and instinct.com"). One sentence, a line, four doodled
 * facts and one action. The sentence is "Tell Claude. ChatGPT already
 * knows.", retyped live by the AIs' own carets (`Tell.web.tsx`): a sees it
 * on paper, b over the map of made-up people and AIs at work. Every claim on
 * them is true of the product today, and the map is labelled a demo.
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
        <Tell />
        <div className="lp-a-row">
          <div className="lp-a-copy">
            <p className="lp-lede">
              Context is one set of notes for you, your team and every AI you use. <Tools /> read and write it with one
              sign‑in.
            </p>
            <Doodles />
          </div>
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
  const left = wide ? Math.min(620, width * 0.42) : 0;
  return (
    <div className="lp-page">
      <Nav />
      <main className="lp-b">
        <div className="lp-b-map">
          <LandingMap paper only={DEMO_IDS.work} inset={wide ? { top: 24, right: 8, bottom: 24, left } : { top: 24, right: 0, bottom: 24, left: 0 }} />
        </div>
        <span className="lp-demo lp-b-label">Demo: made-up people, AIs and notes</span>
        <div className="lp-b-copy">
          <Tell className="lp-tell-3" />
          <p className="lp-lede">
            One set of notes for you, your team and <Tools />. The map is the real one; the people, AIs and notes on it are
            made up.
          </p>
          <SignUpCard />
        </div>
      </main>
      <Footer />
    </div>
  );
}
