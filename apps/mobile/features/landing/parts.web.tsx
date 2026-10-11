import { useConvexAuth } from "convex/react";

/** What every landing page shares: the bar on top, the statement, the foot. */

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

/**
 * The page's one sentence, with the blue square for its full stop. The last
 * word is held to the square so a line break never leaves it on its own.
 */
export function Statement({ children, last }: { children: string; last: string }) {
  return (
    <h1 className="lp-say">
      {children}{" "}
      <span className="lp-nw">
        {last}
        <span className="lp-sq" aria-hidden />
        <span className="lp-sr">.</span>
      </span>
    </h1>
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
