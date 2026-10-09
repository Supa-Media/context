import { Platform } from "react-native";
import { Redirect, useGlobalSearchParams } from "expo-router";
import { useConvexAuth } from "convex/react";
import { resolveRootRoute } from "../auth/redirect";
import { useRememberedContexts } from "../offline/useRememberedContexts";
import { HomeShell } from "./HomeShell";
import { isStudioStage } from "./cast/studioLink";
import { LandingPage } from "../landing/LandingPage";
import { landingFor } from "../landing/route";

/**
 * What `/` is.
 *
 * The decision is `resolveRootRoute`, as a pure function beside the other two
 * route gates, so "a phone does not open on the marketing page" is a rule with
 * a test rather than a `Platform.OS` check buried in a route file.
 *
 * `Platform.OS === "web"` rather than a `.web.tsx` split: the split would put
 * two files in the route registry for one path, and what forks here is one
 * boolean rather than a screen.
 *
 * The remembered session is read here as well as in `(app)/_layout`, because
 * a phone always launches on `/` — without it an offline launch never got as
 * far as the gate that knows how to open offline.
 */
export function RootScreen() {
  const rememberedSession = useRememberedContexts(undefined) !== undefined;
  const decision = resolveRootRoute(useConvexAuth(), Platform.OS === "web", rememberedSession);
  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;
  return <WebHome />;
}

/**
 * On the web, `/` with no `?page=` is landing page a (Dev2, 2026-10-09), and
 * every page of the website (`?page=`, a cast preview, the cast studio) is
 * the console's shell as it was. See `features/landing/route.ts`.
 */
function WebHome() {
  const params = useGlobalSearchParams<{ page?: string | string[] }>();
  const landing =
    typeof window === "undefined"
      ? null
      : landingFor({ pathname: window.location.pathname, page: params.page, hash: window.location.hash, studio: isStudioStage(window) });
  return landing === null ? <HomeShell /> : <LandingPage page={landing} />;
}
