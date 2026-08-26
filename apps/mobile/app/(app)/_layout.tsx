import { Redirect, Stack } from "expo-router";
import { useConvexAuth } from "convex/react";

/**
 * Authenticated route group. Redirects to the login screen when the user is
 * signed out. Auth state comes from @convex-dev/auth via `useConvexAuth`.
 */
export default function AppLayout() {
  const { isAuthenticated, isLoading } = useConvexAuth();

  if (isLoading) return null;

  if (!isAuthenticated) {
    return <Redirect href="/(auth)/login" />;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}
