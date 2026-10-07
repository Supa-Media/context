import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The texted sign-in link's navigator, and **deliberately not a gate**: same
 * reasoning as `app/invite/_layout.tsx`. The screen sends a signed-out visitor
 * to `/login?next=/texts/<token>` itself, so the token survives sign-in.
 */
export default function TextsLayout() {
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
