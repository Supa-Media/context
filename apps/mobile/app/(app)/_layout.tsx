import { useMemo } from "react";
import { Redirect, Stack, usePathname } from "expo-router";
import { useConvexAuth, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { colors } from "../../features/design/tokens";
import { resolveProtectedRoute } from "../../features/auth/redirect";
import { EMPTY_QUERY_SPEC } from "../../features/console/querySpec";
import {
  needsOnboarding,
  standingFrom,
  type WorkspaceStandingRow,
} from "../../features/onboarding/route";

/**
 * Everything under `(app)` needs a session, and an account with nowhere to go
 * needs sending somewhere before any of it means anything.
 *
 * Two gates, in order, both pure functions so they are testable without
 * mounting a router. Auth state comes from `@convex-dev/auth` via
 * `useConvexAuth`; the standing comes from the same `listMyWorkspaces`
 * subscription the console already reads plus `listMyInvitations`, both of
 * which Convex dedupes — this does not add a round trip the app was not
 * already making.
 *
 * ## Why the invitation list is up here at all
 *
 * Because "you have no contexts" and "there is nothing here for you" are not
 * the same sentence, and this layout used to say the first when it meant the
 * second. Somebody who was invited into a context and has not accepted yet has
 * zero workspaces, so the old gate sent them to `/welcome` — and the
 * invitation that brought them to the product in the first place was never
 * shown to them. See `features/onboarding/route.ts` for the full rule.
 *
 * ## The subtlety worth keeping
 *
 * Either query is `undefined` until its first round trip lands, and that is
 * **not** the same as an empty list. `standingFrom` returns `undefined` unless
 * both have landed, and `needsOnboarding` renders rather than redirects while
 * it is unresolved, so a signed-in user with contexts is never thrown into
 * onboarding on a cold load. It also never redirects away from `/welcome` or
 * `/invite` — those screens' own gates own that.
 *
 * ## Why `useQueries` and not two `useQuery` calls
 *
 * This layout used to hold a single `useQuery` guarded by the `"skip"`
 * sentinel, for a reason worth restating: `listMyWorkspaces` calls
 * `requireAuth`, so it **throws** `NOT_AUTHENTICATED` for a client that has no
 * identity yet — and `useQuery` re-throws a failed query *during render*. On a
 * cold start the socket connects before the token comes back out of
 * SecureStore, so the subscription goes out unauthenticated and the error lands
 * in the render phase of the layout that was about to redirect to `/login`.
 * There is no ErrorBoundary above this; the app shows expo-router's crash
 * screen instead of the sign-in page.
 *
 * Adding a second `useQuery` here would double that surface. `useQueries` hands
 * an error back as a *value* instead of throwing it, which is why every other
 * subscribing module in this app uses it — so the empty spec now covers the
 * signed-out case and a failure covers itself. The spec's dependency is a
 * boolean, and `api.…` is reached inside the memo body: see the rule in
 * `features/console/querySpec.ts`, which exists because `api` is a proxy that
 * returns a new object on every access.
 */
export default function AppLayout() {
  const pathname = usePathname();
  // The attempted path is carried into `/login?next=…` so an emailed
  // invitation link survives the sign-in it triggers. `safeNextRoute` narrows
  // it on the way out and again on the way back.
  const decision = resolveProtectedRoute(useConvexAuth(), pathname);
  const authed = decision.action === "render";

  const spec = useMemo<RequestForQueries>(() => {
    if (!authed) return EMPTY_QUERY_SPEC;
    return {
      workspaces: { query: api.functions.workspaces.listMyWorkspaces, args: {} },
      invitations: { query: api.functions.invitations.listMyInvitations, args: {} },
    };
  }, [authed]);
  const results = useQueries(spec);

  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;

  const onboarding = needsOnboarding({
    standing: standingFrom(
      usable<WorkspaceStandingRow[]>(results.workspaces),
      usable<unknown[]>(results.invitations),
    ),
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

/**
 * Convex hands back `undefined` while loading and an `Error` when a query
 * throws. Both mean "no answer yet" to a gate, and a gate that cannot answer
 * must render rather than redirect — a transient failure on either query is
 * not evidence that somebody has no contexts.
 */
function usable<T>(value: unknown): T | undefined {
  if (value === undefined || value instanceof Error) return undefined;
  return value as T;
}
