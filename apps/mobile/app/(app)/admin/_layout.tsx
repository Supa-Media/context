import { Stack } from "expo-router";
import { useColors } from "../../../features/design";

/**
 * The staff console's navigator.
 *
 * A `Stack` and a background colour, like every other nested layout here. The
 * session gate is `(app)`'s and is not repeated; the *staff* gate is not here
 * either, and deliberately — it lives in `requireAdmin` on the server, where a
 * client cannot route around it. A layout that redirected non-staff away would
 * look like the authorization and would not be one.
 */
export default function AdminLayout() {
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
