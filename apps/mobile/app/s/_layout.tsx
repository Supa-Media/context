import { Stack } from "expo-router";
import { colors } from "../../features/design/tokens";

/**
 * The share viewer's navigator, and **deliberately not a gate**.
 *
 * The same arrangement `/invite` uses, for the same reason: a layout-level
 * bounce to a bare `/login` would drop the token out of `/s/<token>`, and that
 * token exists in one message and nowhere else. The screen owns its own auth
 * handling so it can carry the token through sign-in and back.
 *
 * If a session check ever moves up here, it has to carry the attempted path.
 * See `shareSignInHref` in `features/share/share.ts`.
 */
export default function ShareLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    />
  );
}
