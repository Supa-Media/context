import { TexPageScreen } from "../../features/tex/page/TexPageScreen";

/**
 * `/tex/<handle>`: the person's Tex page: what Tex is thinking and doing for
 * them and their groups, its routines, check-ins, what it knows, its settings,
 * and its computer, the page Tex texts when they have to sign in somewhere. Not under the `(app)` group, for the reason `/texts/<token>`
 * is not: the screen owns its sign-in gate so the address survives signing in,
 * and it opens only for the signed-in owner of that handle.
 */
export default function TexPageRoute() {
  return <TexPageScreen />;
}
