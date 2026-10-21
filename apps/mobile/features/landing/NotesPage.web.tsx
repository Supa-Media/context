import { useEffect, type CSSProperties } from "react";
import { useConvexAuth } from "convex/react";
import { notesLandingColors as C, texLaunchColors } from "../design/tokens/landingColors";
import { InlineSignUp } from "./InlineSignUp.web";
import { NOTES_CSS } from "./notesCss";
import { AppWindow, Points, TexBand, Workspaces } from "./notesParts.web";
import { SIGN_UP_CSS } from "./signUpCss";

/**
 * Page a, the front door: the notes page (Dev2, 2026-10-21: "since we have
 * tex.lc and that is more text focused, context.lc's homepage should look
 * more notes focused", then "I like A, but also want to show that you can
 * create different workspaces for free"). A notes app every AI can read, the
 * sign-up, the editor as a picture, what Context is in four lines, a
 * workspace for each part of your life, and Tex as the way in from a phone,
 * linking to tex.lc. Light only, on the brand's Paper.
 */
export const NOTES_TITLE = "Context: notes every AI can read";

export function NotesPage() {
  useEffect(() => {
    const title = document.title;
    document.title = NOTES_TITLE;
    return () => {
      document.title = title;
    };
  }, []);
  const { isAuthenticated } = useConvexAuth();
  const vars = {
    "--paper": C.paper,
    "--sheet": C.sheet,
    "--card": C.card,
    "--hair": C.hair,
    "--rule": C.rule,
    "--line": C.line,
    "--ink": C.ink,
    "--ink2": C.ink2,
    "--ink3": C.ink3,
    "--blue": C.blue,
    "--tint": C.tint,
    "--bad": C.bad,
    "--sage": C.sage,
    "--peach": C.peach,
    "--period": texLaunchColors.period,
    colorScheme: "light",
  } as CSSProperties;
  return (
    <div className="np" style={vars} data-landing="a">
      <style>{NOTES_CSS + SIGN_UP_CSS}</style>
      <header className="np-wrap np-nav">
        <a className="np-brand" href="/" aria-label="Context">
          Context<span className="np-dot" aria-hidden />
        </a>
        <span className="np-sp" />
        <a className="np-hide" href="/?page=pricing">
          Pricing
        </a>
        <a className="np-hide" href="/?page=connect">
          Connect an AI
        </a>
        {isAuthenticated ? (
          <a className="np-pill" href="/console">
            Open Context
          </a>
        ) : (
          <>
            <a href="/login">Sign in</a>
            <a className="np-pill" href="#join">
              Get started
            </a>
          </>
        )}
      </header>
      <main>
        <section className="np-wrap np-hero">
          <h1 className="np-h1">A notes app that every AI you use can read.</h1>
          <p className="np-sub">
            Write in plain Markdown, alone or together. Claude, ChatGPT, Cursor and Codex read the notes you can see and
            write back where you let them.
          </p>
          <div className="np-sign" id="join">
            <InlineSignUp />
          </div>
        </section>
        <AppWindow />
        <Points />
        <Workspaces />
        <TexBand />
      </main>
      <footer className="np-wrap np-foot">
        <b>Context</b>
        <a href="/?page=pricing">Pricing</a>
        <a href="/?page=connect">Connect</a>
        <a href="/?page=devlog">Devlog</a>
        <a className="np-mac" href="/download/mac">
          Download for Mac
        </a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <span className="np-tex">
          Tex, from Context: <a href="https://tex.lc">tex.lc</a>
        </span>
      </footer>
    </div>
  );
}
