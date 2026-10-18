import { useEffect, type CSSProperties } from "react";
import { Tex } from "../chaos/Tex";
import { simpleLandingColors as C } from "../design/tokens/landingColors";
import { InlineSignUp } from "./InlineSignUp.web";
import { TexChat } from "./TexChat.web";
import { TEX_CSS } from "./texCss";

/**
 * Page a, the front door (Dev, 2026-10-18: "we need a new landing page, one
 * that is more Tex/Chat focused … Text your notes we'll organize it for you",
 * replacing the page whose graph "confuses people"). Dev's line as the
 * headline, one sentence of what Tex takes, the sign-up with a button that
 * says what it does, and one conversation with Tex beside it (`TexChat`).
 *
 * Page a's sheet, type and light-only look are kept, so it is the same site.
 * On a computer the whole page fits the window without scrolling; a phone is
 * one column with the sign-up above the conversation.
 */
export function TexPage() {
  useEffect(() => {
    const title = document.title;
    document.title = "Context: text your notes";
    return () => {
      document.title = title;
    };
  }, []);
  const vars = {
    "--paper": C.paper,
    "--ink": C.ink,
    "--ink2": C.ink2,
    "--hair": C.hair,
    "--card": C.card,
    "--bad": C.bad,
    "--blue": C.blue,
    "--bubble": C.bubble,
    "--rule": C.rule,
    colorScheme: "light",
  } as CSSProperties;
  return (
    <div className="tp" style={vars} data-landing="a">
      <style>{TEX_CSS}</style>
      <main className="tp-main">
        <div className="tp-words">
          <a className="tp-tex" href="/" aria-label="Context. Tex, the Context mascot, a blue #">
            <Tex chaos={0} scheme="light" />
          </a>
          <h1 className="tp-h1">
            <span>Text your notes.</span> <span>We'll organize them.</span>
          </h1>
          <p className="tp-sub">
            Send Tex a thought, a link, a photo or a voice memo. It files everything into plain notes you own, then looks
            things up, emails people and reminds you.
          </p>
          <div className="tp-sign">
            <InlineSignUp />
          </div>
        </div>
        <TexChat />
      </main>
      <footer className="tp-foot">
        <a href="/login">Sign in</a>
        <a href="/?page=pricing">Pricing</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <span className="tp-copy">© 2026 Context</span>
      </footer>
    </div>
  );
}
