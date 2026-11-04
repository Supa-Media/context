import { useCallback, useMemo, useRef } from "react";
import { View } from "react-native";
import { Redirect, router, useLocalSearchParams } from "expo-router";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { useColors } from "../../design/theme";
import { Screen } from "../../app/Screen";
import { firstParam } from "../../invite/invite";
import { resolveTexPage, texHref } from "../texComputer";
import { useTexComputer } from "../useTexComputer";
import { TexComputerBody } from "../TexComputerScreen";
import { TexPageBody, type Place } from "./TexPageBody";
import { gatewaySource } from "./texPageSource";
import { withGatewayMachines } from "./texMachineSource";
import { placeParams, readPlace, signInHref } from "./texPlace";
import { useTexPage } from "./useTexPage";
import { T } from "./TexPageParts";

/** A pairing code as the runner prints it: letters and digits, maybe one dash. */
const PAIRING_CODE = /^[A-Za-z0-9]{3,8}-?[A-Za-z0-9]{0,8}$/;

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
  // Read through a ref: the minter changes identity when the sign-in token is
  // refreshed, and a new source would read the whole page again from the top.
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const workspaceId = ready?.workspaceId ?? null;
  const handle = ready?.handle ?? null;

  // A pairing code from the runner's link (`?view=machines&code=KQ7-4MP`), kept while the screen is open:
  // moving to the connect screen drops it from the address, not from the page.
  const codeParam = firstParam(params.code);
  const pairingCode = useRef<string | null>(null);
  if (codeParam && PAIRING_CODE.test(codeParam)) pairingCode.current = codeParam;
  const findPairing = useAction(api.functions.texMachines.pendingTexMachinePairing);
  const approvePairing = useAction(api.functions.texMachines.approveTexMachinePairing);
  const declinePairing = useAction(api.functions.texMachines.declineTexMachinePairing);
  const pairingCalls = useRef({ findPairing, approvePairing, declinePairing });
  pairingCalls.current = { findPairing, approvePairing, declinePairing };

  const source = useMemo(() => {
    if (workspaceId === null || handle === null) return null;
    const token = async (refresh: boolean | { rejected: string }) => (await minting.current({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken;
    return withGatewayMachines(gatewaySource({ endpoint: MCP_ENDPOINT, handle, token }), {
      endpoint: MCP_ENDPOINT,
      workspaceId,
      token,
      selfHandle: handle,
      pairingCode: () => pairingCode.current,
      pairing: {
        find: (code) => pairingCalls.current.findPairing({ code }),
        answer: async (code, approve) => {
          if (approve) await pairingCalls.current.approvePairing({ code, workspaceId: workspaceId as Id<"workspaces"> });
          else await pairingCalls.current.declinePairing({ code });
          return true;
        },
      },
    });
  }, [handle, workspaceId]);
  const page = useTexPage(source, place.chat);
  // The computer is read only while something on screen shows it.
  const showsComputer = place.view === "computer" || place.job !== undefined;
  const computer = useTexComputer({
    workspaceId: showsComputer ? workspaceId : null,
    handle: showsComputer ? handle : null,
    endpoint: showsComputer && ready ? MCP_ENDPOINT : null,
    // A group's page shows that chat's browser (`apps/mcp/src/http/texPage/browser.js`).
    chat: place.chat,
  });

  const go = useCallback(
    (to: Place) => {
      if (handle === null) return;
      router.push({ pathname: "/tex/[handle]", params: { handle, ...placeParams(to) } });
    },
    [handle],
  );

  // Back to the same place after signing in: a handoff's `?view=computer` included.
  if (view.kind === "signIn") return <Redirect href={signInHref(view.href, firstParam(params.handle), place, pairingCode.current)} />;
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
