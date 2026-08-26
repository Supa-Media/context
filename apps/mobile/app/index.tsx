import { Landing } from "../features/landing/Landing";

/**
 * `/` — the public landing page.
 *
 * It stays public when you are signed in; the CTA changes to "Open your
 * console" rather than the page redirecting out from under someone who
 * deliberately navigated here.
 */
export default function LandingRoute() {
  return <Landing />;
}
