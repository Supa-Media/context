import { useState } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import type { ActivityEntry } from "../activity/activity";
import { FaceView } from "../faces/PersonFace";
import { useFace } from "../faces/useFace";
import { countLabel } from "./homeModel";
import { folderActivity, type FolderActor } from "./folderHead";

const FACE = 24;

/**
 * Under a folder's title on a phone (board 07 of the Home artboards, approved
 * 2026-09-30): what it holds, who has been in it this week, and the latest
 * change in one line. The folder's two buttons are `PhoneFolderButtons`, on
 * the title's own row.
 *
 * It takes the place of the pointer layout's "private — yours alone…"
 * sentence: the people mark beside a shared folder's name already says who
 * can see it, and the Share sheet says the rest.
 */
export function PhoneFolderHead({
  folder,
  counts,
  entries,
  onOpen,
  tags = [],
  onTag,
}: {
  folder: string;
  counts: { notes: number; folders: number };
  /** The workspace's activity, already read through the privacy filter; `undefined` where there is none. */
  entries: readonly ActivityEntry[] | undefined;
  onOpen: (path: string) => void;
  /** The folder's own tags, from its front note (`home/folderTags.ts`, board 14). */
  tags?: readonly string[];
  /** Open Home filtered to a tag. */
  onTag?: (tag: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [now] = useState(() => Date.now());
  const { latest, actors } = folderActivity(entries ?? [], folder, now);

  return (
    <View style={styles.head} testID="phone-folder-head">
      <View style={styles.top}>
        <Text variant="meta" style={styles.counts} testID="phone-folder-counts">
          {countLabel(counts.notes, counts.folders)}
        </Text>
        {actors.length === 0 ? null : (
          <View
            style={styles.pile}
            accessibilityLabel={`In this folder this week: ${actors.map((actor) => actor.name ?? "someone").join(", ")}`}
            testID="phone-folder-faces"
          >
            {actors.map((actor, index) => (
              <ActorFace key={actor.key} actor={actor} first={index === 0} />
            ))}
          </View>
        )}
      </View>
      {tags.length === 0 ? null : (
        <View style={styles.tags} testID="phone-folder-tags">
          {tags.map((tag) => (
            <Pressable
              key={tag}
              onPress={onTag === undefined ? undefined : () => onTag(tag)}
              disabled={onTag === undefined}
              accessibilityRole="button"
              accessibilityLabel={`Tagged ${tag}. Show on Home`}
              style={({ pressed }) => [styles.tag, pressed ? styles.pressed : null]}
              testID="phone-folder-tag"
            >
              <Icon name="tag" size={13} color={colors.text2} />
              <Text variant="meta" style={styles.tagText}>
                {tag}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      {latest === null ? null : (
        <Pressable
          onPress={latest.path === null ? undefined : () => onOpen(latest.path as string)}
          disabled={latest.path === null}
          accessibilityRole={latest.path === null ? "text" : "button"}
          accessibilityLabel={`Latest change: ${latest.text}, ${latest.when}`}
          style={({ pressed }) => [styles.latest, pressed ? styles.pressed : null]}
          testID="phone-folder-latest"
        >
          <ActorFace actor={latest.actor} first />
          <Text variant="meta" numberOfLines={1} style={styles.latestText}>
            {`${latest.text} · ${latest.when}`}
          </Text>
          {latest.path === null ? null : <Icon name="chevronRight" size={16} color={colors.muted} />}
        </Pressable>
      )}
    </View>
  );
}

/**
 * A folder's two buttons on a phone: New folder inside, and ••• for everything
 * else you can do to it (board 08). They sit on the title's row, exactly where
 * Home has its own (board 07) — they used to sit a line lower, beside the
 * counts, which made a folder page look unlike Home and dropped them from a
 * project's page altogether, whose property line replaces that line (owner's
 * retest, 2026-10-01).
 */
export function PhoneFolderButtons({
  onNewFolder,
  onActions,
}: {
  onNewFolder?: () => void;
  onActions?: (anchor: { x: number; y: number }) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const at = (event: GestureResponderEvent) => ({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });
  if (onNewFolder === undefined && onActions === undefined) return null;
  return (
    <View style={styles.buttons}>
      {onNewFolder === undefined ? null : (
        <Pressable
          onPress={onNewFolder}
          accessibilityRole="button"
          accessibilityLabel="New folder inside"
          style={({ pressed }) => [styles.round, pressed ? styles.pressed : null]}
          testID="phone-folder-new-folder"
        >
          <Icon name="folderPlus" size={20} color={colors.text} />
        </Pressable>
      )}
      {onActions === undefined ? null : (
        <Pressable
          onPress={(event) => onActions(at(event))}
          accessibilityRole="button"
          accessibilityLabel="Folder actions"
          style={({ pressed }) => [styles.round, pressed ? styles.pressed : null]}
          testID="phone-folder-actions"
        >
          <Icon name="more" size={20} color={colors.text} />
        </Pressable>
      )}
    </View>
  );
}

function ActorFace({ actor, first }: { actor: FolderActor; first: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // An agent is a robot, never its owner's face (Dev2, 2026-09-28).
  const face = useFace(actor.agent ? null : actor.name);
  return (
    <View aria-hidden style={[styles.face, first ? null : styles.faceOverlap, actor.agent ? styles.agent : null]}>
      {actor.agent ? (
        <Icon name="robot" size={Math.round(FACE * 0.6)} color={colors.ink} />
      ) : (
        <FaceView face={face} name={actor.name} size={FACE} />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    head: { gap: space.x2 },
    top: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    counts: { color: colors.muted },
    pile: { flexDirection: "row" },
    buttons: { flexDirection: "row", alignItems: "center", gap: space.x3, flexShrink: 0 },
    round: {
      width: 44,
      height: 44,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.pageSurface,
      boxShadow: shadows.floating,
    },
    pressed: { opacity: 0.6 },
    face: {
      width: FACE,
      height: FACE,
      borderRadius: radii.pill,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: colors.pageSurface,
    },
    faceOverlap: { marginLeft: -6 },
    agent: { borderRadius: 7, backgroundColor: colors.surface2 },
    tags: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    tag: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      minHeight: 30,
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.pageSurface,
    },
    tagText: { color: colors.text2 },
    latest: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 44 },
    latestText: { flex: 1, color: colors.text2 },
  });
