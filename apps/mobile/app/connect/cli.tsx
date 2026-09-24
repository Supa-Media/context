import { CliConnectedScreen } from "../../features/cli/CliConnectedScreen";

/**
 * `/connect/cli?result=...`: where `npx @supa-media/context` sends the browser
 * after signing in. Not under the `(app)` group, like the other connect
 * callbacks: the page needs no session and must not bounce to `/login`.
 */
export default function CliConnectedRoute() {
  return <CliConnectedScreen />;
}
