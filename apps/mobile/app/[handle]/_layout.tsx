import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The short link's navigator, and **deliberately not a gate** — the same
 * arrangement `/s` and `/invite` use, for the same reason.
 *
 * A layout-level bounce to a bare `/login` would drop the address out of
 * `/@seyi/intake`, and for a link whose reader needs no account at all that is
 * a dead end rather than a sign-in. The screen owns its own gate so it can
 * carry the address through sign-in and back; see `signInBackTo` in
 * `features/share/share.ts`.
 */
export default function ShortLinkLayout() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    />
  );
}
