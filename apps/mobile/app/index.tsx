import { RootScreen } from "../features/landing/RootScreen";

/**
 * `/` — the landing page on the web, and the console on a phone.
 *
 * It used to be the landing page everywhere, which meant a native app opened
 * on a page selling the app and offering to install it. See `resolveRootRoute`
 * in `features/auth/redirect.ts` for the rule and why the phone's half of it
 * defers to `/console` rather than naming a context.
 */
export default function RootRoute() {
  return <RootScreen />;
}
