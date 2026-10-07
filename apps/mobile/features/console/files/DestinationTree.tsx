import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { pickerRows } from "./folderPickerModel";
import { baseName } from "./paths";
import type { DestinationView } from "./useDestinationFolders";

/**
 * Another workspace's folders in the pointer layout's Move, as a tree opened
 * a level at a time.
 *
 * A tree rather than this workspace's flat list of paths because the list is
 * not all here: only the folders somebody has opened have been read (see
 * `useDestinationFolders`), and a flat list would read as the whole workspace.
 * Same rows as the phone's place picker, from the same `pickerRows`.
 */
export function DestinationTree({
  label,
  view,
  chosen,
  onChoose,
  onOpen,
}: {
  /** The workspace, by its @name, for the row that is its top level. */
  label: string;
  view: DestinationView;
  chosen: string | null;
  onChoose: (folder: string) => void;
  onOpen: (folder: string) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set([""]));
  const rows = useMemo(
    () =>
      pickerRows({
        folders: view.folders,
        open,
        query: "",
        rootLabel: "/ (root)",
        unexplored: view.unexplored,
        loading: view.loading,
      }),
    [view, open],
  );
  const toggle = (folder: string) => {
    if (!open.has(folder)) onOpen(folder);
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  return (
    <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
      {rows.map((row) => {
        const on = row.path === chosen;
        return (
          <View key={row.path || "/"} style={[styles.line, { paddingLeft: row.depth * 16 }]}>
            {row.opens ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${row.open ? "Close" : "Open"} ${row.path}`}
                onPress={() => toggle(row.path)}
                style={styles.opener}
              >
                <Icon name={row.open ? "chevronDown" : "chevronRight"} size={14} color={colors.muted} />
              </Pressable>
            ) : (
              <View style={styles.opener} />
            )}
            <PressRow
              accessibilityLabel={row.path === "" ? `the top of ${label}` : row.path}
              selected={on}
              onPress={() => onChoose(row.path)}
              radius={radii.sm}
              style={styles.row}
              hoverStyle={styles.rowHover}
              selectedStyle={styles.rowOn}
            >
              <Text variant="tree" style={on ? styles.rowOnLabel : undefined}>
                {row.path === "" ? row.label : baseName(row.path)}
              </Text>
              {row.sub !== undefined && row.path !== "" ? (
                <Text variant="treeMeta" style={styles.rowMeta}>
                  {row.sub}
                </Text>
              ) : null}
            </PressRow>
          </View>
        );
      })}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The same well and rows as `MovePicker`'s list of this workspace's folders.
    list: {
      maxHeight: 220,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.lg,
      backgroundColor: colors.well,
    },
    listContent: { padding: 7 },
    line: { flexDirection: "row", alignItems: "center" },
    opener: { width: 22, height: 26, alignItems: "center", justifyContent: "center" },
    row: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 6,
      paddingHorizontal: 9,
      borderRadius: radii.sm,
    },
    rowHover: { backgroundColor: colors.surface3 },
    rowOn: { backgroundColor: colors.accentDim },
    rowOnLabel: { color: colors.accentText },
    rowMeta: { marginLeft: "auto" },
  });
