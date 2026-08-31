import { Platform } from "react-native";
import { Redirect } from "expo-router";
import { useConvexAuth } from "convex/react";
import { resolveRootRoute } from "../auth/redirect";
import { Landing } from "./Landing";

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
 */
export function RootScreen() {
  const decision = resolveRootRoute(useConvexAuth(), Platform.OS === "web");
  if (decision.action === "wait") return null;
  if (decision.action === "redirect") return <Redirect href={decision.href} />;
  return <Landing />;
}
