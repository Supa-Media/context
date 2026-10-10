import { VaultLinkScreen } from "../../features/vault/VaultLinkScreen";

/**
 * `/vault/<token>`: the private link Tex texts when it needs a login saved or
 * shared. Not under the `(app)` group, for the reason `/texts/<token>` is not:
 * the screen owns its sign-in gate so the token survives signing in.
 */
export default function VaultLinkRoute() {
  return <VaultLinkScreen />;
}
