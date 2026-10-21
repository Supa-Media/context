import { useEffect } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { CONSOLE_ROUTE, LOGIN_ROUTE } from "../../auth/redirect";
import { resetObservabilityUser, trackEvent } from "../../observability/client";
import { TEX_TITLE, TexFooter, TexHeader, TexMark } from "./TexLanding.web";
import { TexLineActions, readableLine } from "./TexStatus.web";
import { TEXT_ROUTE } from "./routes";
import { TEX_LAUNCH_CSS } from "./texLaunchCss";

/**
 * `/text`: where somebody signed in on tex.lc lands, rather than the console
 * (Dev2, 2026-10-20: "it should take them to a page that says 'Text this
 * number' … and then a button under that says open console"). The number to
 * text is the page; the console is one quiet row under it. Open Messages has
 * "hi" typed for somebody who has never texted Tex. The artboards are in
 * tex-signup-gmail-artboards (01, 02).
 *
 * Signed out, it is the sign-in page on the way back here. An account with no
 * phone has no Tex line to show, so it goes on to the console.
 */
export function TexText() {
  useEffect(() => {
    const title = document.title;
    document.title = TEX_TITLE;
    return () => {
      document.title = title;
    };
  }, []);
  const { isLoading, isAuthenticated } = useConvexAuth();
  const home = useQuery(api.functions.texHome.mine, isAuthenticated ? {} : "skip");
  const { signOut } = useAuthActions();

  const leaving = (!isLoading && !isAuthenticated) || home === null || (home !== undefined && home.ending === null);
  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) window.location.replace(`${LOGIN_ROUTE}?next=${encodeURIComponent(TEXT_ROUTE)}`);
    else if (home === null || (home !== undefined && home.ending === null)) window.location.replace(CONSOLE_ROUTE);
  }, [home, isAuthenticated, isLoading]);

  const signOutHere = () => {
    void (async () => {
      await signOut();
      resetObservabilityUser();
      window.location.assign("/");
    })();
  };

  const ready = !leaving && home !== undefined && home !== null && home.ending !== null;
  return (
    <div className="tx" data-landing="tex-text">
      <style>{TEX_LAUNCH_CSS}</style>
      <div className="tx-status">
        <TexHeader
          right={
            ready ? (
              <button type="button" className="tx-quiet" onClick={signOutHere}>
                Sign out
              </button>
            ) : null
          }
        />
        <main className="tx-wrap" aria-busy={!ready}>
          {ready ? <TextTex line={home.line} ending={home.ending!} firstText={home.firstText} /> : null}
        </main>
        <TexFooter />
      </div>
    </div>
  );
}

function TextTex({ line, ending, firstText }: { line: string | null; ending: string; firstText: boolean }) {
  const masked = <strong aria-label={`your number ending in ${ending}`}>•••• {ending}</strong>;
  return (
    <section className="tx-col tx-col-wide">
      <TexMark />
      {line === null ? (
        <>
          <h1 className="tx-big">Almost ready.</h1>
          <p className="tx-body">
            Your Tex line isn't ready yet. We'll text {masked} the number as soon as it is.
          </p>
        </>
      ) : (
        <>
          <h1 className="tx-big">Text Tex.</h1>
          <p className="tx-number tx-number-big">{readableLine(line)}</p>
          <TexLineActions line={line} firstText={firstText} />
          <p className="tx-small tx-note-sm tx-fine">
            Send it from the iPhone you signed up with, {masked}. Tex is iMessage only.
          </p>
        </>
      )}
      <div className="tx-console-row">
        <p>Want to see your notes?</p>
        <a className="tx-btn tx-btn-line tx-btn-compact" href={CONSOLE_ROUTE} onClick={() => trackEvent("tex_console_opened")}>
          Open console
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
    </section>
  );
}
