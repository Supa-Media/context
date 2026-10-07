import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { replayWhen, whenText, type CrossMoveRow, type FeedItem } from "../feed";
import type { MapPageState } from "../hooks/useMapPage";
import { FacePile, ActorFace } from "./ActorFace";
import { PanelHeading } from "./controls";
import { FollowPanel } from "./FollowPanel";

/**
 * The column beside the map. Live: who is working now and what is happening,
 * in words. Replaying: who was there and what was happening at the playhead.
 * Across workspaces: what moved between them. Following an AI tool: what it
 * has read, in order, and what it is writing.
 */
export function MapPanel({ page, onOpenNote }: { page: MapPageState; onOpenNote: (workspaceId: string, path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  if (page.follow !== null) {
    return (
      <View style={styles.panel} testID="map-panel">
        <FollowPanel page={page} onOpenNote={onOpenNote} />
      </View>
    );
  }
  return (
    <View style={styles.panel} testID="map-panel">
      <WorkingNow page={page} />
      {page.scope === "all" && page.many ? <CrossMoves rows={page.crossRows} replaying={page.replaying} /> : null}
      <PanelHeading>{page.replaying ? "At this moment" : "What's happening"}</PanelHeading>
      <Feed items={page.feed} replaying={page.replaying} now={page.now} onOpenNote={onOpenNote} />
    </View>
  );
}

export function WorkingNow({ page, size = 26 }: { page: MapPageState; size?: number }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <PanelHeading testID="map-working-heading">{page.replaying ? "Who was here" : "Working now"}</PanelHeading>
      <View style={styles.pileRow}>
        <FacePile
          actors={page.working}
          size={size}
          following={page.follow?.actorId ?? null}
          onFollow={(id) => page.followActor(id)}
        />
        <Text style={styles.who} testID="map-working-line">
          {page.workingLine}
        </Text>
      </View>
    </View>
  );
}

export function Feed({
  items,
  replaying,
  now,
  onOpenNote,
  compact = false,
}: {
  items: readonly FeedItem[];
  replaying: boolean;
  now: number;
  onOpenNote: (workspaceId: string, path: string) => void;
  compact?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  if (items.length === 0) {
    return (
      <Text variant="meta" testID="map-feed-empty">
        {replaying ? "Nothing had happened yet at this point." : "Nothing has happened in the last few minutes."}
      </Text>
    );
  }
  return (
    <View testID="map-feed" accessibilityRole="list">
      {items.map((item) => (
        <Pressable
          key={item.key}
          onPress={() => onOpenNote(item.workspaceId, item.path)}
          accessibilityRole="button"
          accessibilityHint="Opens the note"
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.feedRow, compact && styles.feedRowCompact, hovered && styles.feedHover]}
          testID="map-feed-row"
        >
          <View style={styles.feedFace}>
            <ActorFace kind={item.actor.kind} name={item.actor.name} size={22} />
          </View>
          <View style={styles.feedText}>
            <Text style={[styles.line, item.now && styles.lineNow]}>
              {isolateForDisplay(item.actor.name)}{" "}
              {item.parts.map((part, index) => (
                <Text key={index} style={part.strong ? styles.strong : undefined}>
                  {part.text}
                </Text>
              ))}
            </Text>
            <Text style={styles.when}>{replaying ? replayWhen(item) : whenText(item, now)}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function CrossMoves({ rows, replaying }: { rows: readonly CrossMoveRow[]; replaying: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section} testID="map-cross-moves">
      <PanelHeading>{replaying ? "Moved between workspaces" : "Moved between workspaces today"}</PanelHeading>
      {rows.length === 0 ? (
        <Text variant="meta">Nothing has moved between your workspaces yet.</Text>
      ) : (
        rows.map((row) => (
          <View key={`${row.from}>${row.to}`} style={styles.between} accessibilityLabel={`${row.count} moved from ${row.fromName} to ${row.toName}`}>
            <Text style={styles.betweenText} numberOfLines={1}>{`${isolateForDisplay(row.fromName)} → ${isolateForDisplay(row.toName)}`}</Text>
            <Text style={styles.betweenCount}>{String(row.count)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

export const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: {
      width: 300,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.lineStrong,
      backgroundColor: colors.pageSurface,
      paddingTop: space.x4,
      // The console's floating new-note button sits over this corner; the
      // last row of the feed stops above it.
      paddingBottom: 88,
      paddingHorizontal: 18,
      gap: space.x3,
      flexShrink: 0,
      overflow: "hidden",
    },
    section: { gap: space.x2, marginBottom: space.x1 },
    pileRow: { gap: space.x2 },
    who: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text2 },
    feedRow: {
      flexDirection: "row",
      gap: 10,
      paddingVertical: space.x2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.lineStrong,
    },
    feedRowCompact: { paddingVertical: 7 },
    feedHover: { backgroundColor: colors.surface2 },
    feedFace: { paddingTop: 1 },
    feedText: { flex: 1, minWidth: 0 },
    line: { fontFamily: fonts.body, fontSize: pointerType.ui, lineHeight: 19, color: colors.text2 },
    lineNow: { color: colors.text },
    strong: { fontWeight: "700", color: colors.text },
    when: { fontFamily: fonts.body, fontSize: pointerType.label, color: colors.chromeMuted, marginTop: 2 },
    between: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: 7,
      paddingHorizontal: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      borderRadius: 9,
    },
    betweenText: { flex: 1, fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.text2 },
    betweenCount: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  });
