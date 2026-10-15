import { useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";

import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii, space, pointerType as t } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { PersonFace } from "../faces/PersonFace";
import { groupByPerson, itemTitle, matchesFilter, type SharedItem } from "./sharedInbox";

/**
 * Board A2's left column: @shared in the place the file tree stands, so the
 * page reads as one more place you can be, the way Drive's Shared with me
 * replaces My Drive's tree rather than opening over it (Dev2, 2026-10-14).
 *
 * Everything (the whole list), then the people who shared with you, each one
 * folding open on the notes they sent; a note opens in place (board A3). The
 * account button stays at the foot, exactly where the tree keeps it.
 */
export function SharedSidebar({
  items,
  selected,
  seenAt,
  onEverything,
  onOpen,
  foot,
}: {
  /** `undefined` while the list has not arrived. */
  items: readonly SharedItem[] | undefined;
  /** The open note's token, or `null` on the list. */
  selected: string | null;
  /** When the reader last opened @shared, for the dots; `null` = never, `undefined` = loading. */
  seenAt: number | null | undefined;
  onEverything: () => void;
  onOpen: (token: string) => void;
  /** The account button, the column's foot. */
  foot: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const [filtering, setFiltering] = useState(false);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());

  const shown = useMemo(() => (items ?? []).filter((item) => matchesFilter(item, query)), [items, query]);
  const people = useMemo(() => groupByPerson(shown), [shown]);
  const isNew = (item: SharedItem) => seenAt !== undefined && (seenAt === null || item.createdAt > seenAt);

  const toggle = (sharedBy: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(sharedBy)) next.delete(sharedBy);
      else next.add(sharedBy);
      return next;
    });

  return (
    <View style={styles.column} testID="shared-sidebar">
      <View style={styles.head}>
        {filtering ? (
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter shared notes"
            placeholderTextColor={colors.muted}
            autoFocus
            onKeyPress={(event) => {
              if (event.nativeEvent.key === "Escape") {
                setQuery("");
                setFiltering(false);
              }
            }}
            style={[styles.filter, fieldFont]}
            accessibilityLabel="Filter shared notes"
            testID="shared-filter"
          />
        ) : (
          <Text variant="eyebrow" style={styles.headLabel} numberOfLines={1}>
            Shared with me
          </Text>
        )}
        <PressRow
          accessibilityLabel={filtering ? "Close the filter" : "Filter shared notes"}
          onPress={() => {
            if (filtering) setQuery("");
            setFiltering(!filtering);
          }}
          radius={radii.md}
          style={styles.iconButton}
          hoverStyle={styles.iconButtonHover}
          testID="shared-filter-toggle"
        >
          <Icon name={filtering ? "close" : "search"} size={14} />
        </PressRow>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <PressRow
          accessibilityLabel={`Everything, ${items?.length ?? 0} notes`}
          selected={selected === null}
          onPress={onEverything}
          radius={radii.sm}
          style={styles.row}
          selectedStyle={styles.rowSelected}
          testID="shared-everything"
        >
          {selected === null ? <View style={styles.selectedBar} testID="shared-here" /> : null}
          <View style={styles.glyph}>
            <Icon name="tray" size={14} />
          </View>
          <Text variant="tree" numberOfLines={1} style={[styles.grow, styles.strong]}>
            Everything
          </Text>
          <Text variant="treeMeta">{items?.length ?? 0}</Text>
        </PressRow>

        {people.length > 0 ? (
          <Text variant="eyebrow" style={styles.section}>
            People
          </Text>
        ) : null}

        {people.map((person) => {
          const open = !folded.has(person.sharedBy);
          return (
            <View key={person.sharedBy}>
              <PressRow
                accessibilityLabel={`${person.label}, ${person.items.length} shared`}
                ariaExpanded={open}
                onPress={() => toggle(person.sharedBy)}
                radius={radii.sm}
                style={styles.row}
                testID={`shared-person-${person.sharedBy}`}
              >
                <View style={styles.chevron}>
                  <Icon name={open ? "chevronDown" : "chevronRight"} size={10} />
                </View>
                <PersonFace name={person.handle === null ? null : `@${person.handle}`} size={16} />
                <Text variant="tree" numberOfLines={1} style={[styles.grow, styles.strong]}>
                  {person.label}
                </Text>
              </PressRow>
              {open
                ? person.items.map((item) => {
                    const here = selected === item.token;
                    return (
                      <PressRow
                        key={item.token}
                        accessibilityLabel={`${itemTitle(item)}${isNew(item) ? ", new" : ""}`}
                        selected={here}
                        onPress={() => onOpen(item.token)}
                        radius={radii.sm}
                        style={[styles.row, styles.noteRow]}
                        selectedStyle={styles.rowSelected}
                        testID={`shared-side-${item.token}`}
                      >
                        {here ? <View style={styles.selectedBar} testID="shared-here" /> : null}
                        <Text variant="tree" numberOfLines={1} style={styles.noteName}>
                          {itemTitle(item)}
                        </Text>
                        {isNew(item) ? <View style={styles.newDot} testID={`shared-side-new-${item.token}`} /> : null}
                      </PressRow>
                    );
                  })
                : null}
            </View>
          );
        })}
      </ScrollView>

      {foot}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    column: { flex: 1, minHeight: 0 },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 28 + space.x2 * 2,
      paddingHorizontal: space.x2,
    },
    headLabel: { flex: 1, minWidth: 0, paddingLeft: space.x2 },
    filter: {
      flex: 1,
      minWidth: 0,
      height: 28,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.well,
      color: colors.text,
      fontSize: t.meta,
      outlineWidth: 0,
      outlineStyle: "none" as never,
    },
    iconButton: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    iconButtonHover: { borderColor: colors.lineStrong },
    scroll: { flex: 1, minHeight: 0 },
    scrollContent: { paddingVertical: space.x1, paddingHorizontal: 6, gap: 1 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingVertical: 5,
      paddingHorizontal: 8,
    },
    rowSelected: { backgroundColor: colors.surface3 },
    /** Board A2's mark on the place you are: a short accent bar at the row's leading edge. */
    selectedBar: {
      position: "absolute",
      left: 0,
      top: 5,
      bottom: 5,
      width: 2,
      borderRadius: 1,
      backgroundColor: colors.accent,
    },
    glyph: { width: 16, alignItems: "center", justifyContent: "center" },
    chevron: { width: 10, alignItems: "center", justifyContent: "center" },
    grow: { flex: 1, minWidth: 0 },
    strong: { color: colors.text },
    section: { paddingHorizontal: space.x2 + 6, paddingTop: space.x4, paddingBottom: space.x1 },
    /** Under the person's name, on the line their name starts on. */
    noteRow: { paddingLeft: 8 + 10 + 6 + 16 + 6 },
    noteName: { flexShrink: 1, minWidth: 0 },
    newDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  });
