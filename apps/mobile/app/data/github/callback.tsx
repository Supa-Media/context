import { GithubCallbackScreen } from "../../../features/console/files/data/GithubCallbackScreen";

/**
 * `/data/github/callback?code=...&installation_id=...&state=...`: where GitHub sends an owner back after installing
 * Context's read-only GitHub App as a data source.
 *
 * Registered with GitHub as the App's callback URL (`https://context.lc/data/github/callback`), so the path is not
 * ours to rename alone. Not under the `(app)` group: that group's gate could send the page elsewhere before it hands
 * GitHub's answer to the console tab that opened it (`githubSync.ts`).
 */
export default function GithubCallbackRoute() {
  return <GithubCallbackScreen />;
}
