import { Redirect, useLocalSearchParams } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { View } from "react-native";
import { api } from "@context/convex/_generated/api";
import { useColors } from "../../features/design/theme";
import { ownTexHref } from "../../features/tex/texComputer";

/**
 * `/tex?…`: the signed-in person's own Tex page, `/tex/<handle>?…`, with the
 * query kept. A runner's pairing link (`/tex?view=machines&code=…`) is made
 * before anyone is known, so it cannot name the handle itself.
 */
export default function OwnTexRoute() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const auth = useConvexAuth();
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, auth.isAuthenticated ? {} : "skip");
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((one) => [k, one] as [string, string])),
  ).toString();
  const next = ownTexHref({ auth, workspaces }, query);
  const colors = useColors();
  if (next.kind === "go") return <Redirect href={next.href ?? "/"} />;
  return <View style={{ flex: 1, backgroundColor: colors.pageSurface }} />;
}
