import { ScrollView, View } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../browser";
import { FileTree } from "../FileTree";
import { NO_PICK } from "../selection";
import { cycleVisibility } from "./rowVisibility";
import { makeStyles } from "./styles";
import type { ExplorerState } from "./useExplorer";

/**
 * The scrolling body of the column: the tree, or the flat ranked list a
 * filter turns it into, and the empty space under the last row. The state is
 * `Explorer`'s; this draws it.
 */
export function ExplorerTree({
  files,
  query,
  contextLabel,
  matches,
  rows,
  select,
  setPicked,
  openMenu,
  onPick,
  dragHandlers,
  dropTarget,
  markedPaths,
  agentMarks,
  background,
}: {
  files: FileBrowser;
  query: string;
  contextLabel: string;
  matches: ExplorerState["matches"];
  rows: ExplorerState["rows"];
  select: ExplorerState["select"];
  setPicked: ExplorerState["setPicked"];
  openMenu: ExplorerState["openMenu"];
  onPick: ExplorerState["onPick"];
  dragHandlers: ExplorerState["dragHandlers"];
  dropTarget: ExplorerState["dropTarget"];
  markedPaths: ExplorerState["markedPaths"];
  agentMarks: ExplorerState["agentMarks"];
  background: ExplorerState["background"];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      role="tree"
      aria-label="Folders and notes"
      testID="explorer-tree"
    >
      {files.loading ? (
        <Text variant="treeMeta" style={styles.status}>
          Reading your bucket…
        </Text>
      ) : matches !== null ? (
        matches.length === 0 ? (
          <Text variant="treeMeta" style={styles.status}>
            Nothing here matches “{query}”. This filters the tree you have open;
            search {contextLabel} itself from the search box.
          </Text>
        ) : (
          matches.map((match) => (
            <PressRow
              key={match.item.id}
              accessibilityLabel={match.item.label}
              selected={files.selectedPath === match.item.id}
              onPress={() => select(match.item.id)}
              radius={radii.sm}
              style={styles.match}
              hoverStyle={styles.matchHover}
              selectedStyle={styles.matchOn}
            >
              <Text variant="tree" numberOfLines={1}>
                {match.item.label}
              </Text>
              {match.item.detail ? (
                <Text variant="treeMeta" numberOfLines={1} style={styles.matchDetail}>
                  {match.item.detail}
                </Text>
              ) : null}
            </PressRow>
          ))
        )
      ) : (
        <FileTree
          rows={rows}
          canSetVisibility={files.canSetVisibility}
          onSelect={select}
          onToggle={(path) => {
            setPicked(NO_PICK);
            files.toggleFolder(path);
            files.select(path);
          }}
          onCycleVisibility={(row) => cycleVisibility(files, row)}
          onMenu={openMenu}
          onPick={onPick}
          drag={dragHandlers}
          dropTarget={dropTarget}
          pendingStateFor={files.pending?.stateFor}
          markedPaths={markedPaths}
          agentMarks={agentMarks}
        />
      )}

      {/*
        The empty space under the last row, as a target rather than as dead
        pixels.

        It is the largest area of this column on any context that does not
        fill the window, and right-clicking it had no answer at all — so the
        browser's menu opened over the file tree, offering Save As and
        Translate to Page on a listing of somebody's notes.

        It is a filler rather than a listener on the scroll view because the
        rows must keep their own gesture: this sits *behind* them and a row's
        handler stops propagation before it ever reaches here. `flexGrow` is
        what makes it the rest of the column rather than a strip; there is no
        minimum, because on a tree that already fills the height there is
        genuinely no background to click.
      */}
      <View style={styles.background} ref={background.ref} collapsable={false} />
    </ScrollView>
  );
}
