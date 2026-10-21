import { ConnectCallbackScreen } from "../../../features/connect/ConnectCallbackScreen";

/**
 * `/connect/<provider>?code=…&state=…`: the URL a connector's provider redirects
 * back to after consent. Not under the `(app)` group, for the same reason
 * `connect/google.tsx` is not: that group's gate can bounce a visitor away from
 * the callback, and the code and state exist for one round trip only.
 */
export default function ConnectCallbackRoute() {
  return <ConnectCallbackScreen />;
}
