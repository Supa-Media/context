import * as SplashScreen from "expo-splash-screen";

/**
 * How long the launch image stays up before the app takes over.
 *
 * ## What it is covering
 *
 * A native cold launch, filmed: the splash for four hundred milliseconds, then
 * **a second of white**, then the console. The white is not a bug in a screen —
 * it is every screen refusing to draw. `(app)/_layout` renders `null` while
 * `useConvexAuth` restores the stored token and opens its socket, which is a
 * network round trip, and the launch image had already been dismissed the
 * moment the JavaScript bundle finished evaluating.
 *
 * Those are two different questions and Expo answers the easier one by default:
 * *is the bundle ready* rather than *is there anything to look at*. So the
 * splash is held past the first and released on the second — one transition
 * from launch image to console instead of two, with a sheet of white between
 * them.
 *
 * ## Why it is bounded, and why the bound is generous
 *
 * A launch image that never goes away is an app that will not start, and the
 * condition being waited on is a network round trip — the one thing that can
 * fail to arrive. Offline, `isLoading` can stay true for as long as the socket
 * keeps trying; without a deadline that is a permanent splash on a plane.
 *
 * Longer than `RECALL_DEADLINE_MS` (600ms, a local store read) because this is
 * waiting on a server rather than on the device, and a launch image is the
 * *right* thing to be looking at while an app starts. Short enough that a
 * failure still resolves into a usable screen — the auth gate sends somebody to
 * sign in, which is the honest answer when the session cannot be restored.
 *
 * ## On the web this is inert
 *
 * There is no launch image in a browser; `expo-splash-screen`'s methods resolve
 * to no-ops there. The web's equivalent of this problem is the shell painting
 * the ground before the bundle runs, and it is solved in `public/index.html`.
 */
export const SPLASH_DEADLINE_MS = 4000;

/**
 * Whether the launch image has already been dismissed.
 *
 * Module state rather than a ref, because the two callers are a module-scope
 * call at startup and an effect that runs on every auth change, and what must
 * happen exactly once is the *hiding*.
 */
let released = false;
let deadline: ReturnType<typeof setTimeout> | null = null;

/**
 * Keep the launch image up. Call once, at module scope, before anything
 * renders.
 *
 * Failures are swallowed on purpose: the only way this rejects is that the
 * splash has already gone, which is the state it was trying to avoid and not
 * one worth an error about. What follows is a white frame, not a broken app.
 */
export function holdSplash(): void {
  if (deadline !== null || released) return;
  void SplashScreen.preventAutoHideAsync().catch(() => {});
  deadline = setTimeout(releaseSplash, SPLASH_DEADLINE_MS);
}

/** Let the app through. Idempotent — every caller may assume it is first. */
export function releaseSplash(): void {
  if (released) return;
  released = true;
  if (deadline !== null) {
    clearTimeout(deadline);
    deadline = null;
  }
  void SplashScreen.hideAsync().catch(() => {});
}

/** Test seam: forget that the splash was ever held. Not used by the app. */
export function resetSplashForTests(): void {
  if (deadline !== null) clearTimeout(deadline);
  deadline = null;
  released = false;
}
