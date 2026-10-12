import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { Tex } from "../chaos/Tex";
import { simpleLandingColors as C } from "../design/tokens/landingColors";
import type { Ink } from "./chaosIcons";
import { ChaosGraph } from "./ChaosGraph.web";
import { LandingSignUp } from "./LandingSignUp";
import { SIMPLE_CSS } from "./simpleCss";

/**
 * Page a, the simple one (Dev, 2026-10-11: "a simple design like these 2",
 * with screenshots of instinct.com and thebrowser.company). Their shape: a
 * small hand-drawn mark, short paragraphs in one reading face at one size, and
 * one call to action written as a line of text. It sells a feeling, less
 * chaos, rather than a feature list, and shows it (`ChaosGraph`) rather than
 * saying it. The words are Dev's own, from the shared note they edited
 * (2026-10-11), with typos fixed and nothing else changed. The sign-up opens
 * under the last line on a phone, and in the graph's place on a computer,
 * where the whole page fits the window without scrolling (Dev2, 2026-10-12).
 *
 * Tex, the mascot, stands where the mark was and untangles as the graph
 * below gets filed. The page is light only and fits Tex, the headline and the
 * whole graph on a laptop's first screen (Dev, 2026-10-11).
 */

/** The canvas's colours: the sheet's, plus a cursor colour per AI helper. */
const INK: Ink = {
  paper: C.paper,
  ink: C.ink,
  ink2: C.ink2,
  hair: C.hair,
  card: C.card,
  blue: C.blue,
  agents: [C.agent1, C.agent2, C.agent3, C.agent4],
};

export function SimplePage() {
  const [open, setOpen] = useState(false);
  // The graph reports every frame; only Tex redraws, not the page.
  const setTex = useRef<(chaos: number) => void>(() => {});
  const onChaos = useCallback((chaos: number) => setTex.current(chaos), []);
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const title = document.title;
    document.title = "Context";
    return () => {
      document.title = title;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    // Into the number field, so the next keystroke is the number and the line
    // just pressed does not keep a focus ring around it.
    form.current?.querySelector("input")?.focus({ preventScroll: true });
    form.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [open]);
  const vars = {
    "--paper": C.paper,
    "--ink": C.ink,
    "--ink2": C.ink2,
    "--hair": C.hair,
    "--mark": C.mark,
    "--card": C.card,
    colorScheme: "light",
  } as CSSProperties;
  return (
    <div
      className="sp"
      style={vars}
      data-landing="a"
      data-joining={open || undefined}
    >
      <style>{SIMPLE_CSS}</style>
      <main className="sp-col">
        <a
          className="sp-tex"
          href="/"
          aria-label="Context. Tex, the Context mascot, a blue scribble that untangles into a # as the notes below are filed"
        >
          <LiveTex register={setTex} />
        </a>
        <h1 className="sp-p sp-first">
          Context is an app that gives your brain that feeling you have when
          your room is clean.
        </h1>
        <ChaosGraph ink={INK} onChaos={onChaos} />
        <p className="sp-p">
          It's an opinionated way to put everything away in plain notes that you
          can always edit, export, do whatever you want with it, and so can all
          your{" "}
          <a className="sp-u" href="/?page=connect-your-ai">
            AI tools
          </a>
          .
        </p>
        <p className="sp-p">
          Work better with your team by organizing your thoughts, start the
          nonprofit, write the blog, build your website
        </p>
        <p className="sp-p sp-less">with less chaos</p>
        <p className="sp-p">
          <button
            type="button"
            className="sp-cta"
            aria-expanded={open}
            aria-controls="join"
            onClick={() => setOpen(true)}
          >
            <span>Join the waitlist</span> ›
          </button>
        </p>
        <div id="join" ref={form} className="sp-join" hidden={!open}>
          {open ? <LandingSignUp /> : null}
        </div>
      </main>
      <footer className="sp-foot">
        <a href="/login">Sign in</a>
        <a href="/?page=pricing">Pricing</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <span className="sp-copy">© 2026 Context</span>
      </footer>
    </div>
  );
}

/** Tex at the graph's level of chaos, starting as a full scribble. */
function LiveTex({
  register,
}: {
  register: MutableRefObject<(chaos: number) => void>;
}) {
  const [chaos, setChaos] = useState(100);
  register.current = setChaos;
  return <Tex chaos={chaos} scheme="light" />;
}
