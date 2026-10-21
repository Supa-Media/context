import { ConnectLinkScreen } from "../../../features/connect/ConnectLinkScreen";

/**
 * `/connect/<provider>/<token>`: the private link Tex texts when it needs a provider connected.
 * Not under the `(app)` group: the screen owns its sign-in gate so the token survives
 * signing in, as `/vault/<token>` does.
 */
export default function ConnectLinkRoute() {
  return <ConnectLinkScreen />;
}
