import { InviteScreen } from "../../features/invite/InviteScreen";

/**
 * `/invite/<token>` — the link somebody was emailed.
 *
 * Deliberately **not** under the `(app)` group, for the same reason
 * `/authorize` is not. That group's gate bounces a signed-out visitor to a bare
 * `/login`, which would drop the token on the floor — and this token exists in
 * one email and nowhere else, with no rail entry that could reproduce it. The
 * screen owns its own gate so it can send people to
 * `/login?next=/invite/<token>` and bring them back to the invitation.
 */
export default function InviteTokenRoute() {
  return <InviteScreen />;
}
