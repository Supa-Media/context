import { DropboxCallbackScreen } from "../../features/console/storage/DropboxCallbackScreen";

/**
 * `/connect/dropbox?code=…&state=…` — the URL Dropbox redirects back to.
 *
 * Registered with Dropbox, so the path is not ours to rename alone: it is
 * matched exactly against `https://context.lc/connect/dropbox` and
 * `http://localhost:4601/connect/dropbox`. `DROPBOX_REDIRECT_ORIGINS` in
 * `features/console/storage/dropbox.ts` is the other half of that agreement,
 * and `infra/router/src/route.ts` is what makes the apex serve this route at
 * all — every page path there proxies to the Expo web app.
 *
 * Deliberately **not** under the `(app)` group, for the same reason
 * `/authorize` and `/invite/<token>` are not: that group's gate bounces a
 * signed-out visitor to a bare `/login` and would drop the code and state, and
 * both exist for about a minute and nowhere else. The screen owns its own gate
 * so it can carry them through sign-in and come back.
 */
export default function DropboxCallbackRoute() {
  return <DropboxCallbackScreen />;
}
