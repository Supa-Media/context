import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import type { PaletteLookIn } from "../../design/components/PaletteSheet";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { findPlaces, taggedLabel, type FolderHit, type LookIn, type TagHit } from "../home/searchPlaces";

/**
 * A phone's search, beyond notes (boards 03 and 04 of the phone Home
 * artboards, approved by the owner on 2026-09-30).
 *
 * Before anything is typed, "Look in" offers Notes, Folders and Tags: pick
 * one to narrow what comes back, pick it again to widen. Folders and Tags
 * then list every one, so the chip is also a way to browse. Once something
 * is typed the chips count where the matches are (All, Notes, Folders,
 * Tags), and the folders and tags that match come first, "since opening one
 * is often the fastest way in". A folder opens its page; a tag opens Home
 * filtered to it.
 *
 * Only ever drawn on a phone: the pointer palette is ⌘K, a navigator over
 * notes, and its rows are walked by the keyboard.
 */
export function lookInFor({
  notes,
  folders,
  scope,
  rootLabel,
  onOpenFolder,
  onOpenTag,
}: {
  notes: readonly { path: string; tags: readonly string[] }[];
  folders: readonly string[];
  /** The folder "Search in <folder>" narrowed to, or `null`. */
  scope: string | null;
  rootLabel: string;
  onOpenFolder: (path: string) => void;
  onOpenTag: (tag: string) => void;
}): PaletteLookIn {
  return {
    render: ({ query, found, look, setLook }) => {
      const typed = query.trim() !== "";
      const chosen = look as LookIn;
      const hits = typed || chosen === "folders" || chosen === "tags"
        ? findPlaces({ query, notes, folders, scope, rootLabel })
        : { folders: [], tags: [] };
      const counts = { notes: found, folders: hits.folders.length, tags: hits.tags.length };
      const shownFolders = chosen === "all" || chosen === "folders" ? hits.folders : [];
      const shownTags = chosen === "all" || chosen === "tags" ? hits.tags : [];
      const showsNotes = chosen === "all" || chosen === "notes";
      return {
        chips: (
          <LookInChips
            value={chosen}
            typed={typed}
            counts={counts}
            onChange={(next) => setLook(next === chosen ? "all" : next)}
          />
        ),
        places: (
          <PlaceRows
            folders={chosen === "all" ? shownFolders.slice(0, 4) : shownFolders}
            tags={chosen === "all" ? shownTags.slice(0, 4) : shownTags}
            look={chosen}
            typed={typed}
            notesFollow={showsNotes && typed && found > 0}
            onOpenFolder={onOpenFolder}
            onOpenTag={onOpenTag}
          />
        ),
        notes: showsNotes,
      };
    },
  };
}

const CHIPS: readonly { look: Exclude<LookIn, "all">; label: string; icon: IconName }[] = [
  { look: "notes", label: "Notes", icon: "file" },
  { look: "folders", label: "Folders", icon: "folder" },
  { look: "tags", label: "Tags", icon: "tag" },
];

function LookInChips({
  value,
  typed,
  counts,
  onChange,
}: {
  value: LookIn;
  typed: boolean;
  counts: { notes: number; folders: number; tags: number };
  onChange: (look: LookIn) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const all = counts.notes + counts.folders + counts.tags;
  const chips = typed
    ? [{ look: "all" as const, label: "All", icon: null, count: all }, ...CHIPS.map((chip) => ({ ...chip, count: counts[chip.look] }))]
    : CHIPS.map((chip) => ({ ...chip, count: null }));
  return (
    <View style={styles.lookIn} testID="search-look-in">
      {typed ? null : (
        <Text variant="eyebrow" style={styles.eyebrow}>
          Look in
        </Text>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {chips.map((chip) => {
          const on = chip.look === value;
          return (
            <Pressable
              key={chip.look}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={chip.count === null ? chip.label : `${chip.label}, ${chip.count}`}
              onPress={() => onChange(chip.look)}
              style={[styles.chip, on && styles.chipOn]}
              testID={`look-in-${chip.look}`}
            >
              {chip.icon === null ? null : (
                <Icon name={chip.icon} size={15} color={on ? colors.accentText : colors.text2} />
              )}
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{chip.label}</Text>
              {chip.count === null ? null : (
                <Text style={[styles.chipCount, on && styles.chipTextOn]}>{String(chip.count)}</Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

function PlaceRows({
  folders,
  tags,
  look,
  typed,
  notesFollow,
  onOpenFolder,
  onOpenTag,
}: {
  folders: readonly FolderHit[];
  tags: readonly TagHit[];
  look: LookIn;
  typed: boolean;
  notesFollow: boolean;
  onOpenFolder: (path: string) => void;
  onOpenTag: (tag: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  if (folders.length === 0 && tags.length === 0) {
    if (look !== "folders" && look !== "tags") return null;
    return (
      <Text variant="rowSub" style={styles.none} testID="search-places-none">
        {look === "folders"
          ? typed ? "No folder is called that." : "No folders yet."
          : typed ? "No tag is called that." : "No notes are tagged yet. Tags come from a note's tags: line."}
      </Text>
    );
  }
  const heading = look === "folders" ? "Folders" : look === "tags" ? "Tags" : "Folders and tags";
  return (
    <View style={styles.places} testID="search-places">
      <Text variant="eyebrow" style={styles.eyebrow}>
        {heading}
      </Text>
      <View style={styles.card}>
        {folders.map((hit, index) => (
          <Pressable
            key={`folder:${hit.path}`}
            accessibilityRole="button"
            accessibilityLabel={`${hit.label}, folder in ${hit.where}, ${hit.counts}`}
            onPress={() => onOpenFolder(hit.path)}
            style={({ pressed }) => [styles.row, index > 0 && styles.rule, pressed && styles.pressed]}
            testID="search-folder"
          >
            <Icon name="folder" size={20} color={colors.text2} />
            <View style={styles.rowText}>
              <Marked text={hit.label} ranges={hit.ranges} />
              <Text variant="meta" numberOfLines={1}>
                {hit.where}
              </Text>
            </View>
            <Text variant="meta" numberOfLines={1}>
              {hit.counts}
            </Text>
          </Pressable>
        ))}
        {tags.map((hit, index) => (
          <Pressable
            key={`tag:${hit.tag}`}
            accessibilityRole="button"
            accessibilityLabel={`Tagged ${hit.tag}, ${taggedLabel(hit.count)}`}
            onPress={() => onOpenTag(hit.tag)}
            style={({ pressed }) => [styles.row, (folders.length > 0 || index > 0) && styles.rule, pressed && styles.pressed]}
            testID="search-tag"
          >
            <Icon name="tag" size={20} color={colors.text2} />
            <View style={styles.rowText}>
              <Text style={styles.rowLabel} numberOfLines={1}>
                {"Tagged "}
                <Marked text={hit.tag} ranges={hit.ranges} inline />
              </Text>
            </View>
            <Text variant="meta" numberOfLines={1}>
              {taggedLabel(hit.count)}
            </Text>
          </Pressable>
        ))}
      </View>
      {notesFollow ? (
        <Text variant="eyebrow" style={styles.eyebrow}>
          Notes
        </Text>
      ) : null}
    </View>
  );
}

/** A name with the letters typed drawn bold on a petrol tint (board 04; no yellow). */
function Marked({
  text,
  ranges,
  inline = false,
}: {
  text: string;
  ranges: readonly (readonly [number, number])[];
  inline?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const parts: { text: string; marked: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), marked: false });
    parts.push({ text: text.slice(start, end), marked: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false });
  const runs = parts.map((part, index) =>
    part.marked ? (
      <Text key={index} style={styles.mark} testID="search-mark">
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
  return inline ? (
    <>{runs}</>
  ) : (
    <Text style={styles.rowLabel} numberOfLines={1}>
      {runs}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lookIn: { gap: space.x2, paddingBottom: space.x2 },
    eyebrow: { paddingHorizontal: layout.readingMargin + space.x1 },
    chips: { gap: space.x2, paddingHorizontal: layout.readingMargin },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1 + 2,
      minHeight: 36,
      paddingHorizontal: space.x3 + 1,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.pageSurface,
    },
    chipOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    chipText: { fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text2, fontWeight: "500" },
    chipCount: { fontFamily: fonts.body, fontSize: touchType.meta, color: colors.muted },
    chipTextOn: { color: colors.accentText },
    places: { gap: space.x2, paddingBottom: space.x3 },
    none: { paddingHorizontal: layout.readingMargin + space.x1, paddingVertical: space.x3 },
    card: {
      marginHorizontal: layout.readingMargin,
      backgroundColor: colors.pageSurface,
      borderRadius: radii.sheet,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      minHeight: 52,
      paddingHorizontal: space.x4,
      paddingVertical: space.x2,
    },
    rule: { borderTopWidth: 1, borderTopColor: colors.line },
    pressed: { backgroundColor: colors.rowSelected },
    rowText: { flex: 1, gap: 1 },
    rowLabel: { fontFamily: fonts.body, fontSize: touchType.ui, color: colors.text },
    mark: { backgroundColor: colors.accentDim, fontWeight: "700", borderRadius: 3 },
  });
