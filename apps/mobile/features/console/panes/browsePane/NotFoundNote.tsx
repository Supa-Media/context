import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Icon, type IconName } from "../../../design/components/Icon";
import { editedLabel } from "../../../design/components/PaletteResultRow";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { radii, space } from "../../../design/tokens";
import {
  BACK_LABEL,
  NOT_FOUND_BODY,
  NOT_FOUND_TITLE,
  SIMILAR_HEADING,
  nearestFolder,
  openFolderLabel,
  searchLabel,
  searchWords,
  similarNotes,
} from "../../files/notFound";
import { baseName, displayName, folderLabel, parentPath } from "../../files/paths";
import type { FolderListing } from "../../files/types";
import { DocumentPage } from "./DocumentPage";

/**
 * A note that was asked for and is not there, drawn where it would be.
 *
 * The sibling of `UnreadableNote`. It replaced "That file does not exist." in
 * the notice band over a `NoteLoading` skeleton that went on pulsing with
 * nothing in flight, which a teammate waited thirty seconds on (Dev,
 * 2026-11-03). One message, in the page, and the ways out: the similarly
 * named notes beside where it was, a search for its name, its folder, back.
 *
 * `FILE_NOT_FOUND` is also the answer for a note the viewer may not see, so
 * the words cover both and everything offered comes from listings the viewer
 * already has (`../../files/notFound.ts`).
 */
export function NotFoundNote({
  path,
  workspace,
  rootLabel,
  listings,
  ensureListing,
  compact,
  onOpen,
  onSearch,
  onBack,
  pathBar,
  notices,
}: {
  /** The path that was asked for. */
  path: string;
  /** `@slug`, as the address named it. */
  workspace: string | null;
  /** What the root is called, for "Open <it>" when the nearest folder is the root. */
  rootLabel: string;
  listings: Readonly<Record<string, FolderListing | undefined>>;
  ensureListing: (path: string) => void;
  compact: boolean;
  onOpen: (path: string) => void;
  onSearch?: (words: string) => void;
  /** Absent where there is nowhere to go back to, or on a phone, which has its own ‹. */
  onBack?: () => void;
  pathBar?: ReactNode;
  notices?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const nearest = nearestFolder(path, listings);
  // The nearest folder is one the viewer's own tree names, so asking for its notes tells nothing.
  const loaded = listings[nearest] !== undefined;
  useEffect(() => {
    if (!loaded) ensureListing(nearest);
  }, [loaded, nearest, ensureListing]);
  const suggestions = useMemo(() => similarNotes(path, nearest, listings), [path, nearest, listings]);
  const words = searchWords(path);
  const folderName = nearest === "" ? rootLabel : folderLabel(baseName(nearest));
  const some = suggestions.length > 0;
  const folder = parentPath(path);
  const name = folder === "" ? path : path.slice(folder.length);

  return (
    <DocumentPage>
      {pathBar}
      {notices}
      <View style={styles.page} testID="note-not-found">
        <View style={styles.titleRow}>
          <Icon name="file" size={16} color={colors.muted} />
          <Text variant="rowTitle" role="heading" aria-level={2} style={styles.title}>
            {NOT_FOUND_TITLE}
          </Text>
        </View>
        <Text variant="paneSub">{NOT_FOUND_BODY}</Text>
        <View
          style={styles.address}
          accessible
          accessibilityLabel={workspace === null ? `Asked for ${path}` : `Asked for ${path} in ${workspace}`}
          testID="note-not-found-address"
        >
          {workspace === null ? null : (
            <Text variant="treeMetaMono" style={styles.addressWorkspace}>
              {workspace}
            </Text>
          )}
          {/* The folders give way first, so the name asked for always shows. */}
          {folder === "" ? null : (
            <Text variant="treeMetaMono" numberOfLines={1} style={styles.addressFolder}>
              {folder}
            </Text>
          )}
          <Text variant="treeMetaMono" numberOfLines={1} style={styles.addressName}>
            {name}
          </Text>
        </View>

        {some ? (
          <View style={styles.similar}>
            <Text variant="eyebrow" role="heading" aria-level={3}>
              {SIMILAR_HEADING}
            </Text>
            <View style={styles.list} testID="note-not-found-similar">
              {suggestions.map((entry, index) => (
                <Row
                  key={entry.path}
                  icon="file"
                  label={displayName(entry.name)}
                  meta={
                    entry.updatedAt === undefined
                      ? folderName
                      : `${folderName} · ${editedLabel(entry.updatedAt)}`
                  }
                  first={index === 0}
                  touch={compact}
                  onPress={() => onOpen(entry.path)}
                  testID={`note-not-found-similar-${index}`}
                />
              ))}
            </View>
          </View>
        ) : null}

        {compact ? (
          // A phone: the ways out are rows too, thumb-sized, under the notes. ‹ is already at the top.
          <View style={[styles.list, styles.actionList]}>
            {onSearch === undefined || words === "" ? null : (
              <Row icon="search" label={searchLabel(words)} first touch onPress={() => onSearch(words)} testID="note-not-found-search" />
            )}
            <Row
              icon="folder"
              label={openFolderLabel(folderName)}
              first={onSearch === undefined || words === ""}
              touch
              onPress={() => onOpen(nearest)}
              testID="note-not-found-folder"
            />
          </View>
        ) : (
          <View style={styles.actions}>
            {onSearch === undefined || words === "" ? null : (
              <Button
                label={searchLabel(words)}
                variant={some ? "mini" : "dialogPrimary"}
                leading={<Icon name="search" size={14} color={some ? colors.text : colors.ink} />}
                onPress={() => onSearch(words)}
                testID="note-not-found-search"
              />
            )}
            <Button
              label={openFolderLabel(folderName)}
              variant={some ? "mini" : "dialog"}
              leading={<Icon name="folder" size={14} color={colors.text} />}
              onPress={() => onOpen(nearest)}
              testID="note-not-found-folder"
            />
            {onBack === undefined ? null : (
              <Button
                label={BACK_LABEL}
                variant={some ? "mini" : "dialog"}
                style={styles.back}
                onPress={onBack}
                testID="note-not-found-back"
              />
            )}
          </View>
        )}
      </View>
    </DocumentPage>
  );
}

/** One row of a list on this page: the tree's file row, with a second line and a chevron. */
function Row({
  icon,
  label,
  meta,
  first,
  touch,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  meta?: string;
  first: boolean;
  touch: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="link"
      accessibilityLabel={meta === undefined ? label : `${label}, ${meta}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.row, touch && styles.rowTouch, !first && styles.rowRule, hovered && styles.rowHover]}
      testID={testID}
    >
      <Icon name={icon} size={touch ? 18 : 16} color={colors.muted} />
      <View style={styles.rowText}>
        <Text variant={touch ? "treeTouch" : "tree"} numberOfLines={1} style={styles.rowTitle}>
          {label}
        </Text>
        {meta === undefined ? null : (
          <Text variant="treeMeta" numberOfLines={1}>
            {meta}
          </Text>
        )}
      </View>
      <Icon name="chevronRight" size={14} color={colors.muted} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingVertical: space.x6, gap: space.x2, maxWidth: 560 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    title: { color: colors.text, flexShrink: 1 },
    address: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      maxWidth: "100%",
      marginTop: space.x1,
      paddingVertical: 3,
      paddingHorizontal: space.x2,
      borderRadius: radii.sm,
      backgroundColor: colors.chipFill,
    },
    addressWorkspace: { color: colors.text2, flexShrink: 0, marginRight: space.x2 },
    addressFolder: { flexShrink: 1, minWidth: 0, textAlign: "right" },
    addressName: { flexShrink: 0, maxWidth: "100%", color: colors.text2 },
    similar: { marginTop: space.x5, gap: space.x2 },
    list: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
    },
    rowTouch: { paddingVertical: space.x3 },
    rowRule: { borderTopWidth: 1, borderTopColor: colors.line },
    rowHover: { backgroundColor: colors.surface2 },
    rowText: { flex: 1, minWidth: 0 },
    rowTitle: { color: colors.text },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2, marginTop: space.x4 },
    actionList: { marginTop: space.x4 },
    back: { borderColor: "transparent", backgroundColor: "transparent" },
  });
