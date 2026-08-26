import { WelcomeScreen } from "../../features/onboarding/WelcomeScreen";

/**
 * `/welcome` — the first run.
 *
 * Under `(app)` because it needs a session, and so a signed-out visitor is sent
 * to `/login` by the group's existing gate rather than by a second copy of that
 * rule here. It is deliberately *not* under `console/`: the console's layout
 * owns the rail, the context switcher, and the storage subscriptions, all of
 * which are about contexts you already have.
 */
export default function WelcomeRoute() {
  return <WelcomeScreen />;
}
