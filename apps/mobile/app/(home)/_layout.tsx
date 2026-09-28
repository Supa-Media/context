import { Slot } from "expo-router";
import { RootScreen } from "../../features/home/RootScreen";

/**
 * `/` — the landing page on the web, and the console on a phone.
 *
 * It used to be the landing page everywhere, which meant a native app opened
 * on a page selling the app and offering to install it. See `resolveRootRoute`
 * in `features/auth/redirect.ts` for the rule and why the phone's half of it
 * defers to `/console` rather than naming a context.
 *
 * **A layout, not the index screen, and that is the fix.** Moving between the
 * site's pages pushes `/?page=` so the browser's Back and the bar's `‹` both
 * have somewhere to go, and each push is a new screen for this route. A layout
 * is kept across its screens' pushes, the way `(app)/console/_layout` keeps
 * the console, so one homepage lasts the whole visit. See `(home)/index.tsx`.
 */
export default function HomeLayout() {
  return (
    <>
      <RootScreen />
      <Slot />
    </>
  );
}
