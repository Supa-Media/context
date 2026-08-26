import { Redirect, Stack, useLocalSearchParams } from "expo-router";
import { useConvexAuth } from "convex/react";
import { colors } from "../../features/design/tokens";
import { resolveAuthRoute } from "../../features/auth/redirect";

/**
 * The sign-in group. A session that already exists has no business here, so it
 * is bounced — to `?next=` when the caller supplied a safe one, and to the
 * console otherwise.
 *
 * The consent screen is what makes `next` earn its keep: someone sent here from
 * `/authorize?request_id=…` has to land back on that exact request, or the AI
 * client's OAuth attempt dies with nothing to retry. The rules — including what
 * makes a `next` target safe to follow — live in `features/auth/redirect.ts`
 * and are tested there.
 */
export default function AuthLayout() {
  const params = useLocalSearchParams<{ next?: string | string[] }>();
  const next = Array.isArray(params.next) ? params.next[0] : params.next;
  const decision = resolveAuthRoute(useConvexAuth(), next);

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
