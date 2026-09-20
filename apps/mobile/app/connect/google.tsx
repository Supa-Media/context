import { GoogleCallbackScreen } from "../../features/console/google/GoogleCallbackScreen";

/**
 * `/connect/google?code=...&state=...` — the URL Google redirects back to.
 *
 * Registered with Google Cloud, so the path is not ours to rename alone: it is
 * matched exactly against `https://context.lc/connect/google` and
 * `http://localhost:4601/connect/google`. The completion secret does not travel
 * through Google; the browser that started the flow has to hand it back here.
 *
 * Deliberately not under the `(app)` group, for the same reason
 * `/connect/dropbox` is not: that group's gate can bounce a signed-out visitor
 * away from the callback URL, and the code and state exist for one OAuth round
 * trip only.
 */
export default function GoogleCallbackRoute() {
  return <GoogleCallbackScreen />;
}
