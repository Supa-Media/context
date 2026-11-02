import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { useColors } from "../../design/theme";
import { Screen } from "../../app/Screen";
import { firstParam } from "../../invite/invite";
import { loginHref } from "../../auth/redirect";
import { normalizeHandle, resolveTexPage, texHref } from "../texComputer";
import { useTexComputer } from "../useTexComputer";
import { TexComputerBody } from "../TexComputerScreen";
import { TexPageBody, type Place } from "./TexPageBody";
import { gatewaySource } from "./texPageSource";
import { readPlace, placeParams } from "./texPlace";
import { useTexPage } from "./useTexPage";
import { T } from "./TexPageParts";

/**
 * `/tex/<handle>`: what Tex is doing for this person, in their own chat or a
 * group they are in (Dev2's v18 mock, approved 2026-11-02). Owns its sign-in
 * gate like `/texts/<token>`, so a signed-out visitor goes to
 * `/login?next=/tex/<handle>` and comes straight back, and it opens only for
 * the signed-in owner of that handle. Which chat, sub-page or job is in the
 * address (`?chat=&view=&job=`), so back and reload keep the place.
 *
 * Tex's computer, full screen, is `?view=computer&full=1`: the remote screen
 * the page used to be, unchanged.
 */
export function TexPageScreen() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const auth = useConvexAuth();
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, auth.isAuthenticated ? {} : "skip");
  const view = resolveTexPage({ handle: firstParam(params.handle), auth, workspaces });
  const ready = view.kind === "ready" ? view : null;
  const place = readPlace(params);
  const mint = useConsoleGrant();
  const workspaceId = ready?.workspaceId ?? null;
  const handle = ready?.handle ?? null;

  const source = useMemo(() => {
    if (workspaceId === null || handle === null) return null;
    return gatewaySource({
      endpoint: MCP_ENDPOINT,
      handle,
      token: async (refresh) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken,
    });
  }, [handle, mint, workspaceId]);
  const page = useTexPage(source, place.chat);
  // The computer is read only while something on screen shows it.
  const showsComputer = place.view === "computer" || place.job !== undefined;
  const computer = useTexComputer({
    workspaceId: showsComputer ? workspaceId : null,
    handle: showsComputer ? handle : null,
    endpoint: showsComputer && ready ? MCP_ENDPOINT : null,
  });

  const go = useCallback(
    (to: Place) => {
      if (handle === null) return;
      router.push({ pathname: "/tex/[handle]", params: { handle, ...placeParams(to) } });
    },
    [handle],
  );

  // Back to the same place after signing in: a handoff's `?view=computer` included.
  if (view.kind === "signIn") return <Redirect href={signInHref(view.href, firstParam(params.handle), place)} />;
  if (view.kind === "notFound" || view.kind === "notYours") {
    return <NotYours own={view.kind === "notYours" ? view.own : null} />;
  }
  if (ready === null || source === null) return <Ground />;
  if (place.view === "computer" && place.full) {
    return <TexComputerBody view={view} computer={computer} />;
  }
  return (
    <Screen testID="tex-page-screen">
      <TexPageBody
        source={source}
        page={page}
        place={place}
        go={go}
        computer={showsComputer ? computer : null}
        openComputer={() => go({ chat: place.chat, view: "computer", full: true })}
      />
    </Screen>
  );
}

function signInHref(fallback: string, raw: string | null | undefined, place: Place): string {
  const query = new URLSearchParams(placeParams(place)).toString();
  const handle = normalizeHandle(raw);
  return query && handle ? loginHref(`${texHref(handle)}?${query}`) : fallback;
}

function Ground() {
  const colors = useColors();
  return <View style={{ flex: 1, backgroundColor: colors.pageSurface }} />;
}

function NotYours({ own }: { own: string | null }) {
  const colors = useColors();
  return (
    <Screen testID="tex-not-yours">
      <View style={{ flex: 1, backgroundColor: colors.pageSurface, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 }}>
        <T size={22} serif line={1.25}>
          This page isn’t yours
        </T>
        <T size={14} tone="muted" style={{ textAlign: "center", maxWidth: 420 }}>
          {own !== null
            ? `Each person's Tex page is at their own address. Yours is context.lc${texHref(own)}.`
            : "Each person's Tex page is at their own address, and only they can open it."}
        </T>
      </View>
    </Screen>
  );
}
