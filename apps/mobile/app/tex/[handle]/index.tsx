import { TexPageScreen } from "../../../features/tex/page/TexPageScreen";

/**
 * `/tex/@<handle>`: the person's Tex page: what Tex is thinking and doing for
 * them and their groups, its routines, check-ins, what it knows, its settings,
 * and its computer, the page Tex texts when they have to sign in somewhere,
 * and when they ask what it is working on. Not under the `(app)` group, for
 * the reason `/texts/<token>` is not: the screen owns its sign-in gate so the
 * address survives signing in, and it opens only for the signed-in owner of
 * that handle. Its sub-pages are `[...rest].tsx`.
 */
export default function TexPageRoute() {
  return <TexPageScreen />;
}
