import { Redirect, Stack } from "expo-router";
import { useConvexAuth } from "convex/react";
import { colors } from "../../features/design/tokens";
import { resolveAuthRoute } from "../../features/auth/redirect";

/**
 * The sign-in group. A session that already exists has no business here, so it
 * is bounced to the console. The rules — including what makes a `next` target
 * safe to follow — live in `features/auth/redirect.ts` and are tested there.
 */
export default function AuthLayout() {
  const decision = resolveAuthRoute(useConvexAuth());

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
