import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The invitation flow's navigator, and **deliberately not a gate**.
 *
 * Both screens under it own their own auth handling, exactly as `/authorize`
 * does: a layout-level bounce to a bare `/login` would drop the token out of
 * `/invite/<token>`, and that token exists in one email and nowhere else. This
 * layout therefore does one job — give the two routes a stack and paint the
 * same dark ground every other route paints, so nothing flashes white on the
 * way in.
 *
 * If a session check ever moves up here, it has to carry the attempted path.
 * See `loginHref` in `features/auth/redirect.ts`.
 */
export default function InviteLayout() {
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
