import { Redirect, Stack } from "expo-router";
import { useConvexAuth } from "convex/react";
import { colors } from "../../features/design/tokens";
import { resolveProtectedRoute } from "../../features/auth/redirect";

/**
 * Everything under `(app)` needs a session. Auth state comes from
 * `@convex-dev/auth` via `useConvexAuth`; the decision itself is a pure
 * function so it can be tested without mounting a router.
 */
export default function AppLayout() {
  const decision = resolveProtectedRoute(useConvexAuth());

  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    />
  );
}
