import { useConvexAuth } from "convex/react";

/** What every landing page shares: the bar on top and the foot. */

/** The top of every version: the name, and sign in. */
export function Nav() {
  const { isAuthenticated } = useConvexAuth();
  return (
    <nav className="lp-nav" aria-label="Context">
      <a className="lp-brand" href="/">
        Context
        <span className="lp-sq" aria-hidden />
      </a>
      <span className="lp-sp" />
      {isAuthenticated ? (
        <a className="lp-link" href="/console">
          Open Context →
        </a>
      ) : (
        <a className="lp-link" href="/login">
          Sign in
        </a>
      )}
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="lp-foot">
      <span>© Context</span>
      <span className="lp-sp" />
      <a href="/?page=pricing">Pricing</a>
      <a href="/?page=connect">Connect</a>
      <a href="/?page=devlog">Devlog</a>
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </footer>
  );
}
