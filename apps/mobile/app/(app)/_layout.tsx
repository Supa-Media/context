import { Redirect, Stack, usePathname } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { colors } from "../../features/design/tokens";
import { resolveProtectedRoute } from "../../features/auth/redirect";
import { needsOnboarding } from "../../features/onboarding/route";

/**
 * Everything under `(app)` needs a session, and an account with no context
 * needs onboarding before any of it means anything.
 *
 * Two gates, in order, both pure functions so they are testable without
 * mounting a router. Auth state comes from `@convex-dev/auth` via
 * `useConvexAuth`; the context count comes from the same `listMyWorkspaces`
 * subscription the console already reads, which Convex dedupes — this does not
 * add a round trip.
 *
 * ## The subtlety worth keeping
 *
 * `listMyWorkspaces` is `undefined` until its first round trip lands, and that
 * is **not** the same as an empty list. `needsOnboarding` renders rather than
 * redirects while it is unresolved, so a signed-in user with contexts is never
 * thrown into onboarding on a cold load. It also never redirects away from
 * `/welcome` — the flow's own gate owns that, because only it knows whether a
 * name was claimed in this session. See `features/onboarding/route.ts`.
 *
 * ## Why the query is skipped rather than merely ignored
 *
 * This asked for `listMyWorkspaces` unconditionally, above both gates, on the
 * reasoning that a subscription nobody reads is harmless. It is not.
 * `listMyWorkspaces` calls `requireAuth`, so it **throws** `NOT_AUTHENTICATED`
 * for a client that has no identity yet — and `useQuery` re-throws a failed
 * query *during render*. On a cold start the socket connects before the token
 * comes back out of SecureStore, so the subscription goes out unauthenticated
 * and the error lands in the render phase of the layout that was about to
 * redirect to `/login`. There is no ErrorBoundary above this; the app shows
 * expo-router's crash screen instead of the sign-in page.
 *
 * `"skip"` is the fix, and it is still an unconditional hook call: `useQuery`
 * takes the skip sentinel as an argument and reduces to an empty `useQueries`
 * spec, so hook order does not move.
 */
export default function AppLayout() {
  const decision = resolveProtectedRoute(useConvexAuth());
  const pathname = usePathname();
  const workspaces = useQuery(
    api.functions.workspaces.listMyWorkspaces,
    decision.action === "render" ? {} : "skip",
  );

  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;

  const onboarding = needsOnboarding({
    contextCount: workspaces === undefined ? undefined : workspaces.length,
    pathname,
  });
  if (onboarding.action === "redirect") return <Redirect href={onboarding.href} />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.ground },
      }}
    />
  );
}
