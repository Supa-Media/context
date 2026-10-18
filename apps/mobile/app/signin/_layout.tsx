import { Stack } from "expo-router";
import { useColors } from "../../features/design/theme";

/**
 * The texted sign-in link's navigator, and deliberately not a gate: the page
 * signs its visitor in itself (`features/signInLink/SignInLinkScreen.tsx`).
 */
export default function SignInLinkLayout() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }} />;
}
