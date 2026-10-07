import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../../design/components/Text";
import { fonts, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { FollowState } from "../engine";
import { useFollowText, writingPreview } from "../hooks/useFollowText";
import type { MapPageState } from "../hooks/useMapPage";
import { ActorFace } from "./ActorFace";
import { PanelHeading } from "./controls";

/** What somebody being followed is doing, in words: "Reading Pricing". */
export function followDoing(follow: Pick<FollowState, "doing" | "at">): string {
  const title = follow.at?.title ?? null;
  if (follow.doing === null || title === null) return "Not on a note right now";
  if (follow.doing === "read") return `Reading ${title}`;
  if (follow.doing === "edit") return `Writing in ${title}`;
  if (follow.doing === "create") return `Writing a new note, ${title}`;
  if (follow.doing === "move") return `Moving ${title}`;
  return `On ${title}`;
}

/** Whether the followed one is writing a note right now. */
export function writingTarget(follow: FollowState | null): { workspaceId: string; path: string; title: string } | null {
  if (follow === null || follow.at === null) return null;
  return follow.doing === "edit" || follow.doing === "create" ? follow.at : null;
}

/**
 * Following one AI tool (or person): who, what it is doing, the notes it has
 * read so far in the order it read them — each opens that note — and, while it
 * writes, the note's words arriving.
 */
export function FollowPanel({ page, onOpenNote }: { page: MapPageState; onOpenNote: (workspaceId: string, path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const follow = page.follow!;
  const writing = writingTarget(follow);
  const text = useFollowText(page.replaying ? null : writing);
  return (
    <View style={styles.follow} testID="map-follow-panel">
      <View style={styles.head}>
        <ActorFace kind={follow.kind} name={follow.name} size={30} />
        <View style={styles.headText}>
          <Text style={styles.name} numberOfLines={1}>
            {isolateForDisplay(follow.name)}
          </Text>
          <Text style={styles.sub} numberOfLines={2}>
            {followDoing(follow)}
          </Text>
        </View>
      </View>
      {follow.kind === "agent" ? (
        <>
          <PanelHeading testID="map-follow-count">{`Has read ${follow.reads.length} ${follow.reads.length === 1 ? "note" : "notes"}, in this order`}</PanelHeading>
          <View style={styles.reads} accessibilityRole="list">
            {follow.reads.map((note, index) => (
              <Pressable
                key={`${note.workspaceId}\n${note.path}`}
                onPress={() => onOpenNote(note.workspaceId, note.path)}
                accessibilityRole="button"
                accessibilityLabel={`${index + 1}. ${note.title}. Opens the note`}
                style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.read, hovered && styles.readHover]}
                testID="map-follow-read"
              >
                <Text style={styles.readIndex}>{`${index + 1}.`}</Text>
                <Text style={styles.readTitle} numberOfLines={1}>
                  {isolateForDisplay(note.title)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      {writing !== null ? <Writing title={writing.title} text={text} reducedMotion={page.reducedMotion} /> : null}
    </View>
  );
}

function Writing({ title, text, reducedMotion }: { title: string; text: string | null; reducedMotion: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const target = text === null ? "" : writingPreview(text);
  const shown = useTyped(target, reducedMotion);
  return (
    <View style={[styles.writing, { borderColor: colors.accent }]} testID="map-follow-writing">
      <Text style={styles.writingTitle}>{`Writing: ${isolateForDisplay(title)}`}</Text>
      <Text style={styles.writingText}>
        {shown}
        {reducedMotion ? null : <Text style={{ color: colors.accent }}>▍</Text>}
      </Text>
    </View>
  );
}

/**
 * The words arriving: what was already shown stays, and what is new types in
 * at a reading pace. Under reduced motion it is all there at once.
 */
export function useTyped(target: string, reducedMotion: boolean): string {
  const [count, setCount] = useState(reducedMotion ? target.length : 0);
  const [last, setLast] = useState(target);
  if (last !== target) {
    // New text that does not extend the old is shown whole, rather than retyped.
    setLast(target);
    if (!target.startsWith(last.slice(0, count))) setCount(target.length);
  }
  useEffect(() => {
    if (reducedMotion) {
      setCount(target.length);
      return;
    }
    if (count >= target.length) return;
    const timer = setTimeout(() => setCount((c) => Math.min(target.length, c + 3)), 40);
    return () => clearTimeout(timer);
  }, [count, target, reducedMotion]);
  return target.slice(0, Math.min(count, target.length));
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    follow: { gap: space.x3 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    headText: { flex: 1, minWidth: 0 },
    name: { fontFamily: fonts.body, fontSize: 15, fontWeight: "700", color: colors.text },
    sub: { fontFamily: fonts.body, fontSize: 12, color: colors.chromeMuted },
    reads: { gap: 6 },
    read: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: colors.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    readHover: { backgroundColor: colors.surface3 },
    readIndex: { width: 20, fontFamily: fonts.body, fontSize: 13, color: colors.chromeMuted },
    readTitle: { flex: 1, fontFamily: fonts.body, fontSize: 13, color: colors.text },
    writing: { borderWidth: 1, borderRadius: 10, padding: 12, minHeight: 92, backgroundColor: colors.pageSurface, gap: 4 },
    writingTitle: { fontFamily: fonts.body, fontSize: 13, fontWeight: "700", color: colors.text },
    writingText: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: colors.text },
  });
