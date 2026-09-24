import { TextInput, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../browser";
import { setListingOrder } from "../listingOrder";
import { IconButton } from "./IconButton";
import { makeStyles } from "./styles";
import type { ExplorerState } from "./useExplorer";

/**
 * The column's header: its name at rest, the filter, and the tools that
 * arrive on approach. The state is `Explorer`'s; this draws it.
 */
export function ExplorerToolbar({
  files,
  selectedFolder,
  setDialog,
  descending,
  query,
  setQuery,
  closeFilter,
  toolsShown,
  filterFocused,
  setFilterFocused,
}: {
  files: FileBrowser;
  selectedFolder: ExplorerState["selectedFolder"];
  setDialog: ExplorerState["setDialog"];
  descending: ExplorerState["descending"];
  query: string;
  setQuery: ExplorerState["setQuery"];
  closeFilter: ExplorerState["closeFilter"];
  toolsShown: boolean;
  filterFocused: boolean;
  setFilterFocused: ExplorerState["setFilterFocused"];
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);

  /**
   * The controls across the top of the column.
   *
   * Sort and collapse are about the *panel* rather than about the context, so
   * neither is gated on `canEdit`: a member reading somebody else's notes has
   * as much use for a folded tree as its owner does.
   *
   * There is no fifth. A "Close the file tree" button used to be drawn under
   * `touch`, and on a pointer layout it would be a fourth way to do what ⌘B
   * and the top bar's toggle already do, on the one density where there is
   * nothing covering the note to dismiss.
   *
   * There was briefly a sixth: a gear that started the one-time storage-layout
   * update. It is gone from here rather than reordered — a maintenance
   * operation somebody runs once, or never, does not earn permanent room
   * beside the four controls they use every day. It lives in Settings →
   * Storage and in a dismissible notice now; see
   * `../storage/StorageMigration.tsx`, which holds the argument and the copy.
   */
  /*
    THE HEADER'S TOOLS, IN TWO GROUPS, AND THE SPLIT IS THE CANVAS'S.

    All four used to arrive together on approach, on the argument that four
    lit buttons over a list of names is the loudest thing in the quietest
    region. That argument was right about *four* and wrong about zero: the
    canvas draws two of them at rest — new note and collapse-all — and a
    header with a name and nothing else reads as a caption rather than as the
    top of a panel you can do things to.

    Which two is not arbitrary. These are the pair with no other route: ⌘N has
    no equivalent for "collapse everything", and both act on the column rather
    than on a row, so neither is in a row's context menu. The pair that fades
    — new folder, and the sort direction — are both reachable from a folder's
    own menu, and sorting is something you set once.
  */
  const restingActions = (
    <>
      {files.canEdit ? (
        <IconButton
          label="New note"
          icon="plus"
          /*
            Makes it, rather than asking what to call it. See `untitled.ts`: the
            note arrives as `untitled-<date>` and takes the first heading typed
            into it.
          */
          onPress={() => files.createUntitled(selectedFolder, "note")}
          testID="explorer-new-note"
        />
      ) : null}
      <IconButton
        label="Collapse every folder"
        icon="collapse"
        onPress={files.collapseAll}
        testID="explorer-collapse"
      />
    </>
  );

  const approachActions = (
    <>
      {files.canEdit ? (
        <IconButton
          label="New folder"
          icon="folder"
          onPress={() => setDialog({ kind: "newFolder", folder: selectedFolder })}
          testID="explorer-new-folder"
        />
      ) : null}
      <IconButton
        label={descending ? "Sort A to Z" : "Sort Z to A"}
        icon="sort"
        onPress={() => setListingOrder(!descending)}
        testID="explorer-sort"
      />
    </>
  );

  /**
   * The filter, permanently in the column's header.
   *
   * No `autoFocus`: this field has always been on the screen, and a permanent
   * field that takes the caret on mount steals it from whatever somebody was
   * doing. It was autofocused under `touch`, where it was a field that had just
   * been *revealed* by a press, and that arm is gone with the density.
   *
   * ## Its box is chrome, so its box arrives on approach
   *
   * The *field* is permanent and stays permanent — it is a real input with a
   * real caret at every moment, and nothing about reaching it changed. What
   * was permanent and should not have been is the 28pt bordered well it was
   * drawn in: at rest it was an empty box at the top of a column whose whole
   * job is to be a quiet list of names, and it was the loudest thing in it —
   * exactly what the four icon buttons beside it were faded for.
   *
   * So at rest it is the word `Filter` in muted type, which reads as the
   * column's label; the border and the fill come in with the buttons. Kept
   * while the query is non-empty, because a field somebody has typed into is
   * not chrome — and while it has focus, so tabbing to it does not land the
   * caret in something that looks like a heading.
   */
  const filterField = (
    <TextInput
      value={query}
      onChangeText={setQuery}
      /*
        Blank until the header is lit, because `Notes` is drawn over the field
        at rest and two words in one box is what a placeholder underneath a
        label looks like. The accessible name is unconditional and on the line
        below, so nothing about reaching this field depends on the word.
      */
      placeholder={toolsShown || filterFocused ? "Filter" : ""}
      placeholderTextColor={colors.muted}
      onFocus={() => setFilterFocused(true)}
      onBlur={() => setFilterFocused(false)}
      style={[
        styles.filter,
        (toolsShown || filterFocused || query !== "") && styles.filterBoxed,
      ]}
      accessibilityLabel="Filter notes and folders"
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      testID="explorer-filter"
    />
  );

  return (
    <View style={styles.toolbar}>
      {/*
        THE COLUMN'S NAME, AT REST, OVER THE FIELD RATHER THAN BESIDE IT.

        The design's tree opens on the word `Notes` — an eyebrow, the way
        every panel in this product labels itself — and the header's controls
        arrive with the pointer. What was here instead was the filter's
        placeholder, which is a different word for a different thing: `Filter`
        answers "what does this box do" and says nothing about what the
        column below it is.

        Drawn *over* the field, absolutely, and faded out as the tools fade
        in — so the field is mounted at every moment, keeps its caret, keeps
        its place in the tab order, and nothing about the row's geometry
        depends on which of the two is visible. `pointerEvents="none"` so the
        label cannot take the press that focuses the field underneath it.

        It goes when the filter has something in it as well as on approach:
        a column showing eight of its forty rows must say why, and `Notes`
        over a filtered tree is a label telling a small lie.
      */}
      <View
        style={[styles.eyebrow, (toolsShown || filterFocused || query !== "") && styles.eyebrowGone]}
        pointerEvents="none"
        aria-hidden
      >
        <Text variant="eyebrow">Notes</Text>
      </View>
      {filterField}
      {query !== "" ? (
        <IconButton
          label="Clear the filter"
          icon="close"
          onPress={closeFilter}
          testID="explorer-filter-clear"
        />
      ) : null}
      <View style={styles.toolbarSpacer} />
      <View style={[styles.tools, toolsShown && styles.toolsShown]}>{approachActions}</View>
      {/*
        Never faded. See `restingActions` — the canvas's header has these two
        at rest, and the fade is now about the pair beside them rather than
        about the whole toolbar.
      */}
      <View style={styles.toolsResting}>{restingActions}</View>
    </View>
  );
}
