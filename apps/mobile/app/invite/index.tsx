import { InviteListScreen } from "../../features/invite/InviteListScreen";

/**
 * `/invite` — the invitations addressed to this account.
 *
 * Where `needsOnboarding` sends an account with no contexts of its own but an
 * invitation waiting. Outside `(app)` alongside `/invite/[token]`, so both
 * halves of the flow answer the auth question the same way.
 */
export default function InviteListRoute() {
  return <InviteListScreen />;
}
