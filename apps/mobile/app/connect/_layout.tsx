import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The storage-connect callbacks' navigator, and **deliberately not a gate**.
 *
 * Same shape and the same reasoning as `app/invite/_layout.tsx`: a
 * layout-level bounce to a bare `/login` would drop the `code` and `state` out
 * of `/connect/dropbox`, and those two exist for about a minute and in one URL.
 * This layout does one job — give the route a stack and paint the same dark
 * ground every other route paints, so nothing flashes white on the way in.
 *
 * If a session check ever moves up here, it has to carry the attempted path.
 * See `loginHref` in `features/auth/redirect.ts`.
 */
export default function ConnectLayout() {
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
