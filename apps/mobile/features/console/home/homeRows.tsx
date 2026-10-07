import { Fragment, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { countLabel, type HomeFolder, type HomeNoteTile } from "./homeModel";

/*
 * The pieces Home is built from (`PhoneHome`): a labelled section, a card of
 * ruled rows, a pinned or often-opened tile, a note row, a folder row, and
 * the row that opens the live map. Each draws what it is handed and decides
 * nothing about what goes on Home.
 */

export function Section({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text variant="eyebrow" style={styles.sectionLabel} accessibilityRole="header">
        {label}
      </Text>
      {children}
    </View>
  );
}

export function Card({ children }: { children: ReactNode[] }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.card}>
      {children.map((child, index) => (
        <Fragment key={index}>
          {index === 0 ? null : <View style={styles.rule} />}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

export function Tile({
  icon,
  title,
  shared,
  lines,
  onPress,
  onLongPress,
  style,
}: {
  icon: IconName;
  title: string;
  shared: boolean;
  lines: string[];
  onPress: () => void;
  onLongPress?: () => void;
  style: object;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[title, ...lines].join(", ")}
      accessibilityHint={onLongPress === undefined ? undefined : "Hold to pin or unpin"}
      style={({ pressed }) => [styles.tile, style, pressed ? styles.pressed : null]}
    >
      <Icon name={icon} size={20} color={colors.text2} />
      <View style={styles.tileTitleRow}>
        <Text style={styles.tileTitle} numberOfLines={1}>
          {title}
        </Text>
        {shared ? <Icon name="people" size={14} color={colors.markTeam} /> : null}
      </View>
      {lines.map((line) => (
        <Text key={line} variant="meta" numberOfLines={1}>
          {line}
        </Text>
      ))}
    </Pressable>
  );
}

export function NoteRow({
  note,
  when,
  onPress,
  onLongPress,
}: {
  note: HomeNoteTile;
  when: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const detail = [note.place, note.lede].filter((part): part is string => !!part).join(" · ");
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={[note.title, detail, when].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      <Icon name="file" size={20} color={colors.text2} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {note.title}
          </Text>
          <Text variant="meta">{when}</Text>
        </View>
        {detail === "" ? null : (
          <Text variant="meta" numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/** The live map's row on Home: a place, like a folder, that opens the map. */
export function MapPlace({ onPress }: { onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Card>
      {[
        <Pressable
          key="map"
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel="Map, who is working in this workspace, live"
          style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
          testID="phone-home-map"
        >
          <Icon name="liveMap" size={20} color={colors.text2} />
          <View style={styles.folderName}>
            <Text style={styles.rowTitle} numberOfLines={1}>
              Map
            </Text>
          </View>
          <Text variant="meta" numberOfLines={1} style={styles.counts}>
            Who is working, live
          </Text>
          <Icon name="chevronRight" size={16} color={colors.muted} />
        </Pressable>,
      ]}
    </Card>
  );
}

export function FolderLine({
  folder,
  onPress,
  onLongPress,
}: {
  folder: HomeFolder;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const counts = countLabel(folder.notes, folder.folders);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${folder.title}${folder.shared ? ", shared" : ""}, ${counts}`}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
      testID="phone-home-folder"
    >
      <Icon name="folder" size={20} color={colors.text2} />
      <View style={styles.folderName}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {folder.title}
        </Text>
        {folder.shared ? <Icon name="people" size={14} color={colors.markTeam} /> : null}
      </View>
      <Text variant="meta" numberOfLines={1} style={styles.counts}>
        {counts}
      </Text>
      <Icon name="chevronRight" size={16} color={colors.muted} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pressed: { opacity: 0.6 },
    section: { gap: space.x2 },
    sectionLabel: { paddingHorizontal: space.x1 },
    tile: {
      backgroundColor: colors.pageSurface,
      borderRadius: radii.sheet,
      padding: space.x4,
      gap: space.x1,
      minHeight: 104,
    },
    tileTitleRow: { flexDirection: "row", alignItems: "center", gap: space.x1 + 2, marginTop: space.x2 },
    tileTitle: {
      fontFamily: fonts.body,
      fontSize: touchType.ui,
      fontWeight: "600",
      color: colors.text,
      flexShrink: 1,
    },
    card: { backgroundColor: colors.pageSurface, borderRadius: radii.sheet, overflow: "hidden" },
    rule: { height: 1, marginLeft: space.x4 + 20 + space.x3, backgroundColor: colors.line },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 52,
      paddingHorizontal: space.x4,
      paddingVertical: space.x3,
    },
    rowPressed: { backgroundColor: colors.rowSelected },
    rowText: { flex: 1, gap: 2 },
    rowTop: { flexDirection: "row", alignItems: "baseline", gap: space.x2 },
    rowTitle: { flexShrink: 1, flexGrow: 1, fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text },
    folderName: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.x1 + 2 },
    counts: { flexShrink: 0 },
  });
