import { JoinScreen } from "../../../features/auth/JoinScreen";

/**
 * `/join/<token>` — the link in a friend's invite email.
 *
 * Under `(auth)` beside `/login`, because it is `/login` with the invite on
 * top: it works signed out, and somebody already signed in is sent on to the
 * app by that group's gate. The token exists in one email and nowhere else, so
 * nothing in the app links here (`features/app/unreachableRoutes.ts`).
 */
export default function JoinTokenRoute() {
  return <JoinScreen />;
}
