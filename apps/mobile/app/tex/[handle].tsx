import { TexComputerScreen } from "../../features/tex/TexComputerScreen";

/**
 * `/tex/<handle>`: the person's own view of the browser Tex drives for them,
 * the page Tex texts when they have to sign in somewhere. Not under the
 * `(app)` group, for the reason `/texts/<token>` is not: the screen owns its
 * sign-in gate so the address survives signing in, and it opens only for the
 * signed-in owner of that handle.
 */
export default function TexComputerRoute() {
  return <TexComputerScreen />;
}
