import { Children, Fragment, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type GestureResponderEvent } from "react-native";
import { RowOpeningBar } from "../files/RowOpening";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { EmojiGlyph } from "../emoji/EmojiGlyph";
import { fonts, pointerType, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { countLabel, type HomeFolder, type HomeNoteTile } from "./homeModel";

/*
 * The pieces Home is built from (`PhoneHome`): a labelled section, a card of
 * ruled rows, a pinned or often-opened tile, a note row, a folder row, and
 * the row that opens the live map. Each draws what it is handed and decides
 * nothing about what goes on Home.
 */


/** Where a row was held, so its menu opens under the finger. */
export interface HoldPoint {
  x: number;
  y: number;
}

const held = (onLongPress: ((at: HoldPoint) => void) | undefined) =>
  onLongPress === undefined
    ? undefined
    : (event: GestureResponderEvent) => onLongPress({ x: event.nativeEvent.pageX, y: event.nativeEvent.pageY });

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

export function Card({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  // Flattened, so a list of rows and a last line after it are ruled alike.
  const rows = Children.toArray(children);
  return (
    <View style={styles.card}>
      {rows.map((child, index) => (
        <Fragment key={index}>
          {/* Edge to edge, as the boards draw every list on the phone's top pages. */}
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
  opening = false,
}: {
  icon: IconName;
  title: string;
  shared: boolean;
  lines: string[];
  onPress: () => void;
  onLongPress?: (at: HoldPoint) => void;
  style: object;
  /** Its page is being read while Home stays on screen (`useShownEntry`): it says so (`RowOpening.tsx`). */
  opening?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={held(onLongPress)}
      accessibilityRole="button"
      accessibilityLabel={[title, ...lines].join(", ")}
      accessibilityHint={onLongPress === undefined ? undefined : "Hold for more actions"}
      style={({ pressed }) => [styles.tile, style, pressed || opening ? styles.pressed : null]}
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
      {opening ? <RowOpeningBar /> : null}
    </Pressable>
  );
}

export function NoteRow({
  note,
  when,
  onPress,
  onLongPress,
  opening = false,
}: {
  note: HomeNoteTile;
  when: string;
  onPress: () => void;
  onLongPress?: (at: HoldPoint) => void;
  /** See `Tile`. */
  opening?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const detail = [note.place, note.lede].filter((part): part is string => !!part).join(" · ");
  return (
    <Pressable
      onPress={onPress}
      onLongPress={held(onLongPress)}
      accessibilityRole="button"
      accessibilityLabel={[note.title, detail, when].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed || opening ? styles.rowPressed : null]}
    >
      <Icon name="file" size={20} color={colors.text2} />
      <View style={styles.rowText}>
        <View style={styles.rowTop}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {note.title}
          </Text>
          <Text variant="meta" numberOfLines={1} style={styles.rowWhen}>
            {when}
          </Text>
        </View>
        {detail === "" ? null : (
          <Text variant="meta" numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {opening ? <RowOpeningBar /> : null}
    </Pressable>
  );
}

/**
 * A pinned note on Folders (board 2): its name, then when it changed and the
 * folder it is in, with no icon — the same row Inbox draws a loose note as.
 */
export function PinnedNote({
  title,
  when,
  place,
  onPress,
  onLongPress,
  opening = false,
}: {
  title: string;
  when: string;
  place: string;
  onPress: () => void;
  onLongPress?: (at: HoldPoint) => void;
  opening?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={held(onLongPress)}
      accessibilityRole="button"
      accessibilityLabel={[title, when, place].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.lineRow, pressed || opening ? styles.rowPressed : null]}
      testID="phone-home-pinned"
    >
      <Text style={styles.lineTitle} numberOfLines={1}>
        {title}
      </Text>
      <Text style={styles.lineSub} numberOfLines={1}>
        {when === "" ? null : <Text style={styles.lineWhen}>{when}</Text>}
        {when === "" || place === "" ? "" : "\u2002 "}
        {place}
      </Text>
      {opening ? <RowOpeningBar /> : null}
    </Pressable>
  );
}

export function FolderLine({
  folder,
  icon = null,
  onPress,
  onLongPress,
  opening = false,
}: {
  folder: HomeFolder;
  /** The emoji this folder was given, drawn in place of the folder icon. `null` for the plain one. */
  icon?: string | null;
  onPress: () => void;
  onLongPress?: (at: HoldPoint) => void;
  /** See `Tile`. */
  opening?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const counts = countLabel(folder.notes, folder.folders);
  // Board 2 draws the number alone: "48 ›". The words stay for a screen reader.
  const count = folder.notes === 0 && folder.folders === 0 ? "Empty" : String(folder.notes);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={held(onLongPress)}
      accessibilityRole="button"
      accessibilityLabel={`${folder.title}${folder.shared ? ", shared" : ""}, ${counts}`}
      style={({ pressed }) => [styles.row, pressed || opening ? styles.rowPressed : null]}
      testID="phone-home-folder"
    >
      {icon === null ? (
        <Icon name="folder" size={20} color={colors.text2} />
      ) : (
        <EmojiGlyph
          emoji={icon}
          size={20}
          textStyle={styles.folderEmoji}
          fallback={<Icon name="folder" size={20} color={colors.text2} />}
          testID="phone-home-folder-emoji"
        />
      )}
      <View style={styles.folderName}>
        <Text style={[styles.rowTitle, styles.folderTitle]} numberOfLines={1}>
          {folder.title}
        </Text>
      </View>
      {folder.shared ? <Icon name="people" size={15} color={colors.markTeam} /> : null}
      <Text numberOfLines={1} style={styles.counts}>
        {count}
      </Text>
      <Icon name="chevronRight" size={16} color={colors.muted} />
      {opening ? <RowOpeningBar /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pressed: { opacity: 0.6 },
    section: { gap: space.x2 },
    sectionLabel: { paddingHorizontal: space.x1 },
    tile: {
      backgroundColor: colors.cardSurface,
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
    card: { backgroundColor: colors.cardSurface, borderRadius: radii.sheet, overflow: "hidden" },
    rule: { height: 1, backgroundColor: colors.line },
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
    /** "You edited Thu" stays one line beside a long title; the title gives way. */
    rowWhen: { flexShrink: 0 },
    folderName: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.x1 + 2 },
    /** Where the 20pt folder icon sits, so a row with an emoji lines up with one without. */
    folderEmoji: { width: 20, textAlign: "center", fontSize: touchType.h3, lineHeight: 24 },
    counts: { flexShrink: 0, fontFamily: fonts.body, fontSize: pointerType.lede, color: colors.muted },
    folderTitle: { fontSize: touchType.body, fontWeight: "600" },
    lineRow: { paddingHorizontal: space.x4, paddingVertical: space.x3, gap: 2, minHeight: 60, justifyContent: "center" },
    lineTitle: { fontFamily: fonts.body, fontSize: touchType.body, fontWeight: "600", color: colors.text },
    lineSub: { fontFamily: fonts.body, fontSize: pointerType.lede, color: colors.muted },
    lineWhen: { fontWeight: "600", color: colors.text },
  });
