import { Stack } from "expo-router";
import { useColors } from "../../../features/design/theme";

/**
 * GitHub's install callback's navigator (`/data/github/callback`), and deliberately not a gate: the page only
 * hands GitHub's answer to the console tab that opened it, and a bounce to sign-in would drop it. Same shape as
 * `app/connect/_layout.tsx`.
 */
export default function DataGithubLayout() {
  const colors = useColors();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.ground } }} />;
}
