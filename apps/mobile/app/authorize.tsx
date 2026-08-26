import { ConsentScreen } from "../features/consent/ConsentScreen";

/**
 * `/authorize?request_id=…` — the OAuth consent screen.
 *
 * Deliberately **not** under the `(app)` group, even though it needs a session.
 * That group's gate bounces a signed-out visitor to a bare `/login`, which
 * would drop the `request_id` on the floor and leave the AI client's OAuth
 * attempt with nothing to retry. This screen owns its own gate so it can send
 * people to `/login?next=/authorize?request_id=…` and bring them back.
 */
export default function AuthorizeRoute() {
  return <ConsentScreen />;
}
