import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The agent's computer page's navigator, and **deliberately not a gate**: same
 * reasoning as `app/invite/_layout.tsx`. The screen sends a signed-out visitor
 * to `/login?next=/tex/<handle>` itself, so the address survives sign-in.
 */
export default function TexLayout() {
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
