import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { ScreenViewport, useSurfacePadding } from "../../app/Screen";
import { densityFor } from "../../app/frame";
import { layout } from "../../design/tokens";
import { useColors } from "../../design/theme";
import { ContextIcon } from "../../console/files/contextIcons/ContextIcon";
import type { Id } from "@context/convex/_generated/dataModel";
import { useConsoleGrant } from "../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { NowContext, T } from "../page/TexPageParts";
import { gatewaySource } from "../page/texPageSource";
import { chatFileKind, groupChatAt, historyFileChat } from "./historyFile";
import { HistoryFileLines } from "./HistoryFileLines";
import { ConversationsList } from "../conversations/ConversationsList";

/**
 * A history file opened in the app (`tex/history.ledger.json`, or a group
 * home's): the chat's history as the lines the Tex page draws, never the file's
 * JSON as text (owner, 2026-11-02: "just have one history file and then
 * different views ... have that be a special object"). Read through the
 * viewer's own Tex page routes with a console grant on their personal
 * workspace, so a chat they are not one of the people of is refused by the
 * gateway, as on the page.
 *
 * It owns its scroller: the title and the filters stay above it, and it opens
 * at the newest line (`HistoryFileLines`). On a phone it pays for the floating
 * chrome itself, as a note does.
 */
export function HistoryFileView({
  path,
  workspace,
  own,
}: {
  path: string;
  workspace: { id: string; slug: string };
  /** The viewer's own personal workspace, whose Tex page this reads through. */
  own: { id: string; slug: string } | null;
}) {
  // The grant minter and the workspace rows change identity whenever the
  // console's data refreshes (every few seconds while anything moves): the
  // source is keyed on the ids alone, so a refresh never reads the history
  // again from the top (Dev, 2026-11-02: "the page randomly refreshes every
  // 20 or so seconds").
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const ownId = own?.id ?? null;
  const ownSlug = own?.slug ?? null;
  const place = historyFileChat(path, workspace, ownId === null ? null : { id: ownId });
  const source = useMemo(() => {
    if (ownId === null || ownSlug === null) return null;
    return gatewaySource({
      endpoint: MCP_ENDPOINT,
      handle: ownSlug,
      token: async (refresh) => (await minting.current({ workspaceId: ownId as Id<"workspaces"> }, refresh)).accessToken,
    });
  }, [ownId, ownSlug]);
  const folder = place.kind === "group" ? place.folder : null;
  const [group, setGroup] = useState<{ key: string; name: string } | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    setGroup(undefined);
    if (folder === null || source === null) return;
    void source.overview("me").then((r) => {
      if (!live) return;
      const found = r.kind === "ok" ? groupChatAt(r.value.chats, workspace.slug, folder) : null;
      setGroup(found ? { key: found.key, name: found.name } : null);
    });
    return () => {
      live = false;
    };
  }, [folder, source, workspace.slug]);

  const chat = place.kind === "me" ? "me" : place.kind === "group" ? (group?.key ?? null) : null;
  const waiting = place.kind === "group" && group === undefined && source !== null;

  const compact = densityFor(useWindowDimensions().width) === "compact";
  const padding = useSurfacePadding();
  const pad = compact ? { top: padding.content.top, bottom: padding.content.bottom, side: layout.readingMargin } : { top: 0, bottom: 0, side: 40 };
  // The conversations file beside it opens the same way, as the chat's conversations (Dev2, 2026-11-07).
  const kind = chatFileKind(path);
  const head = <HistoryHead whose={place.kind === "group" && group ? group.name : null} kind={kind} />;

  const body =
    source === null || place.kind === "none" || (place.kind === "group" && group === null) ? (
      <View style={{ gap: 12, paddingTop: pad.top, paddingHorizontal: pad.side }}>
        {head}
        <T size={14} tone="muted" testID="history-file-not-yours">
          This chat's history opens for the people in it, from their own Tex.
        </T>
      </View>
    ) : waiting || chat === null ? (
      <View style={{ gap: 12, paddingTop: pad.top, paddingHorizontal: pad.side }}>
        {head}
        <ActivityIndicator size="small" />
      </View>
    ) : kind === "conversations" ? (
      <ScrollView style={styles.fill} contentContainerStyle={{ gap: 12, paddingTop: pad.top, paddingBottom: pad.bottom + 24, paddingHorizontal: pad.side }} testID="conversations-file">
        {head}
        <ConversationsList source={source} chat={chat} group={place.kind === "group"} phone={compact} />
      </ScrollView>
    ) : (
      <HistoryFileLines source={source} chat={chat} group={place.kind === "group"} head={head} pad={pad} phone={compact} />
    );

  return (
    <NowContext.Provider value={Date.now}>
      <Frame compact={compact} padding={padding}>
        <View style={styles.fill} testID="history-file">
          {body}
        </View>
      </Frame>
    </NowContext.Provider>
  );
}

/** One thin row (Dev, 2026-11-03: "can the header be thinner somehow"): the icon, History (or Conversations), and whose. */
export function HistoryHead({ whose, kind = "history" }: { whose: string | null; kind?: "history" | "conversations" }) {
  const colors = useColors();
  return (
    <View style={styles.title}>
      <ContextIcon part={kind === "conversations" ? "tex_chats" : "tex_history"} size={18} tint={colors.accent} />
      <T size={17} serif weight="600" line={1.25} testID="history-file-title">
        {kind === "conversations" ? "Conversations" : "History"}
      </T>
      {whose !== null ? (
        <T size={14} tone="muted" numberOfLines={1} style={styles.whose}>
          {whose}
        </T>
      ) : null}
    </View>
  );
}

/** A phone holds the status bar's band back, as a note's scroller does; a pointer layout's pane pads itself. */
function Frame({ compact, padding, children }: { compact: boolean; padding: ReturnType<typeof useSurfacePadding>; children: ReactNode }) {
  return compact ? <ScreenViewport padding={padding}>{children}</ScreenViewport> : <View style={styles.fill}>{children}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  title: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32 },
  whose: { flexShrink: 1 },
});
