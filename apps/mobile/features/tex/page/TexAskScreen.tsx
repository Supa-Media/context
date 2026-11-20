import { useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { loginHref } from "../../auth/redirect";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { Button } from "../../design/components/Button";
import { useColors } from "../../design/theme";
import { Screen } from "../../app/Screen";
import { firstParam } from "../../invite/invite";
import { ownWorkspace } from "../texComputer";
import { gatewaySource } from "./texPageSource";
import { askAnswerLine, ASK_KEY, type AskState } from "./texAsk";
import { T } from "./TexPageParts";

/**
 * `/tex/ask?k=<key>`: Tex's "Go ahead?" card, opened in a browser or the app instead of Messages (Dev2, 2026-11-20:
 * "even if it does open as a web link, it should still work"). The card's address is this page's, so a tap that does
 * not reach the Messages extension lands here: signed in, Yes or Not now goes to the person's own chat with Tex as the
 * card's own answer would (`packages/tex/worker/pageAnswer.ts`), and Tex answers in Messages.
 */
export function TexAskScreen() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const key = firstParam(params.k) ?? "";
  const auth = useConvexAuth();
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, auth.isAuthenticated ? {} : "skip");
  const own = workspaces === undefined ? undefined : ownWorkspace(workspaces);
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const source = useMemo(() => {
    if (!own) return null;
    const token = async (refresh: boolean | { rejected: string }) => (await minting.current({ workspaceId: own.workspaceId as Id<"workspaces"> }, refresh)).accessToken;
    return gatewaySource({ endpoint: MCP_ENDPOINT, handle: own.handle, token });
  }, [own?.handle, own?.workspaceId]);
  const [state, setState] = useState<AskState>({ kind: "asking" });
  const colors = useColors();

  if (auth.isLoading) return <View style={{ flex: 1, backgroundColor: colors.pageSurface }} />;
  if (!auth.isAuthenticated) return <Redirect href={loginHref(`/tex/ask?k=${encodeURIComponent(key)}`) as never} />;
  const valid = ASK_KEY.test(key);
  const answer = async (yes: boolean) => {
    if (source === null) return;
    setState({ kind: "sending", yes });
    const done = await source.act("me", { type: "answer", ask: key, yes });
    setState(done.ok ? { kind: "done", yes } : { kind: "failed", error: done.error ?? "unavailable" });
  };
  const heading = !valid ? "This card can't be answered" : state.kind === "done" ? (state.yes ? "You said yes." : "You said not now.") : "Go ahead with what Tex asked?";
  const line = !valid ? "Reply to Tex in Messages instead." : askAnswerLine(state, own === null);
  const busy = state.kind === "sending" || source === null;
  return (
    <Screen testID="tex-ask-screen">
      <View style={{ flex: 1, backgroundColor: colors.pageSurface, alignItems: "center", justifyContent: "center", padding: 24, gap: 14 }}>
        <T size={22} serif line={1.25}>
          {heading}
        </T>
        {line ? (
          <T size={14} tone="muted" style={{ textAlign: "center", maxWidth: 420 }} testID="tex-ask-line">
            {line}
          </T>
        ) : null}
        {valid && own !== null && (state.kind === "asking" || state.kind === "sending") ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button label="Yes, go ahead" variant="accent" disabled={busy} onPress={() => void answer(true)} testID="tex-ask-yes" />
            <Button label="Not now" variant="mini" disabled={busy} onPress={() => void answer(false)} testID="tex-ask-no" />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
