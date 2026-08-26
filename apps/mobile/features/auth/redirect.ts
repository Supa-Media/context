/**
 * Where a session is allowed to be.
 *
 * Kept as pure functions rather than inline `if`s in the layouts so the rules
 * — including the one that stops a crafted `?next=` from bouncing a signed-in
 * user off-site — are testable without mounting a router.
 */

export const LANDING_ROUTE = "/";
export const LOGIN_ROUTE = "/login";
export const CONSOLE_ROUTE = "/console";

export interface AuthState {
  /** True until @convex-dev/auth has finished restoring the stored token. */
  isLoading: boolean;
  isAuthenticated: boolean;
}

export type RouteDecision =
  /** Auth is still resolving — render nothing rather than flashing a screen. */
  | { action: "wait" }
  | { action: "render" }
  | { action: "redirect"; href: string };

/**
 * The `(app)` group. Anything under it needs a session; without one we send the
 * visitor to sign in.
 *
 * Note we deliberately do *not* thread the attempted URL through as `?next=`
 * yet: the console's own routes are all reachable from its rail once you land,
 * and a redirect parameter is an open-redirect surface that has to be earned.
 */
export function resolveProtectedRoute(state: AuthState): RouteDecision {
  if (state.isLoading) return { action: "wait" };
  if (!state.isAuthenticated) return { action: "redirect", href: LOGIN_ROUTE };
  return { action: "render" };
}

/**
 * The `(auth)` group. A signed-in visitor has no business on the sign-in
 * screen; bounce them to the console, or to `next` when it is safe.
 */
export function resolveAuthRoute(state: AuthState, next?: string): RouteDecision {
  if (state.isLoading) return { action: "wait" };
  if (!state.isAuthenticated) return { action: "render" };
  return { action: "redirect", href: safeNextRoute(next) };
}

/**
 * The landing page is public, and stays public when you are signed in — the CTA
 * changes instead of the page disappearing. This exists so the CTA has one
 * place to ask where it points.
 */
export function landingCtaHref(state: AuthState): string {
  return state.isAuthenticated ? CONSOLE_ROUTE : LOGIN_ROUTE;
}

export function landingCtaLabel(state: AuthState): string {
  return state.isAuthenticated ? "Open your console" : "Create your context";
}

/**
 * Narrows a caller-supplied redirect target to a same-origin path.
 *
 * Anything that could leave the app — an absolute URL, a protocol-relative
 * `//evil.example`, a `javascript:` payload, a backslash that some parsers
 * normalise to a slash — falls back to the console. This repository is public
 * and the sign-in flow is the highest-value place to plant an open redirect.
 */
export function safeNextRoute(next: string | undefined | null): string {
  if (typeof next !== "string") return CONSOLE_ROUTE;

  const trimmed = next.trim();
  if (trimmed.length === 0) return CONSOLE_ROUTE;
  // Must be a rooted path…
  if (!trimmed.startsWith("/")) return CONSOLE_ROUTE;
  // …but not a protocol-relative URL, nor one disguised with backslashes.
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return CONSOLE_ROUTE;
  if (trimmed.includes("\\")) return CONSOLE_ROUTE;
  // No control characters (a `\n` can smuggle a second header or split a URL).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return CONSOLE_ROUTE;

  return trimmed;
}
