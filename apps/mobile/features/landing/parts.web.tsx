import type { ReactNode } from "react";
import { useConvexAuth } from "convex/react";

/** What every landing page shares: the bar on top, the headline, the way to the sign-up, the foot. */

/** The top of every version: the name, sign in, and the way to the sign-up. */
export function Nav({ cta = true }: { cta?: boolean }) {
  const { isAuthenticated } = useConvexAuth();
  return (
    <nav className="lp-nav" aria-label="Context">
      <a className="lp-brand" href="/">
        Context
      </a>
      <span className="lp-sp" />
      <a className="lp-link lp-hide" href="/?page=pricing">
        Pricing
      </a>
      {isAuthenticated ? (
        <a className="lp-pill lp-dark" href="/console">
          Open Context
        </a>
      ) : (
        <>
          <a className="lp-link" href="/login">
            Sign in
          </a>
          {cta ? <JoinLink /> : null}
        </>
      )}
    </nav>
  );
}

/** Takes the visitor to the page's sign-up card. */
export function JoinLink({ dark = false }: { dark?: boolean }) {
  return (
    <a className={dark ? "lp-pill lp-dark" : "lp-pill"} href="#join">
      Sign in or join →
    </a>
  );
}

/** "Less chaos." with the blue square for its full stop. */
export function Headline({ as: Tag = "h1", children = "Less chaos" }: { as?: "h1" | "h2"; children?: ReactNode }) {
  return (
    <Tag className="lp-h1">
      {children}
      <span className="lp-sq" aria-hidden />
      <span className="lp-sr">.</span>
    </Tag>
  );
}

export function Footer() {
  return (
    <footer className="lp-foot">
      <b>Context</b>
      <a href="/?page=pricing">Pricing</a>
      <a href="/?page=connect">Connect</a>
      <a href="/?page=devlog">Devlog</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </footer>
  );
}
