import { Stack } from "expo-router";
import { useColors } from "../../../features/design/theme";

/**
 * The workspace-creation flow's navigator, and **deliberately not a gate**.
 *
 * The session check is already above it: everything under `(app)` goes through
 * that group's layout, which sends a signed-out visitor to `/login` carrying
 * the attempted href. A second check here would be a second copy of a rule that
 * has one correct implementation, and the onboarding gate in that same layout
 * must not fire for this route either — somebody who owns a brain already and
 * is making a workspace is not a person with nothing.
 *
 * So this does one job: give the route a stack and paint the same dark ground
 * every other route paints, so nothing flashes white on the way in.
 */
export default function WorkspaceLayout() {
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
