import { Stack } from "expo-router";
import { useColors } from "../../../features/design/theme";

/**
 * `/join/<token>`'s navigator. The sign-in gate is `(auth)`'s, one level up;
 * this only paints the same ground so nothing flashes white on the way in.
 */
export default function JoinLayout() {
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
