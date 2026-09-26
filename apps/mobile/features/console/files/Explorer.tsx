import { View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Menu } from "../../design/components/Menu";
import { Text } from "../../design/components/Text";
import { radii } from "../../design/tokens";
import { useColors, useThemedStyles } from "../../design/theme";
import { useFrame } from "../../app/AppFrame";
import { ExplorerDialogs } from "./explorer/ExplorerDialogs";
import { ExplorerFoot } from "./explorer/ExplorerFoot";
import { ExplorerFootLists } from "./explorer/ExplorerFootLists";
import { ExplorerToolbar } from "./explorer/ExplorerToolbar";
import { ExplorerTree } from "./explorer/ExplorerTree";
import type { ExplorerProps } from "./explorer/props";
import { makeStyles } from "./explorer/styles";
import { useExplorer } from "./explorer/useExplorer";

/**
 * The file tree, as a region of the application rather than a box inside a pane.
 *
 * It used to be a 246px column with a hard `maxHeight: 432`, sitting inside the
 * Browse pane's content area, inside a page that scrolled — so the tree scrolled
 * within a box within a scrolling document, and a context with a few hundred
 * notes was unusable. Here it owns a region: it fills the height available, it
 * is the only thing that scrolls inside itself, and on a wide window it can be
 * dragged wider.
 *
 * ## The toolbar is one button, not three
 *
 * Browse carried a permanent "New note" / "New folder" / "Paste …" row. Those
 * are now a single `+`, because creating something is one intent with two
 * shapes, and because the operations that used to need buttons are reachable
 * where they belong — on the row itself, through a right-click on a pointer and
 * a long press under a thumb.
 *
 * ## This is a pointer-layout region, and it draws one presentation
 *
 * **Two whole density forks lived here and neither could ever run.** This file
 * carried a `const touch = frame.density === "compact"` and branched on it a
 * dozen times: a footer icon row in place of the header toolbar, a filter that
 * was a revealed field rather than a permanent one, an autofocus, a "Close the
 * file tree" button, thumb-sized targets, and a `touch` prop handed down to
 * `FileTree`. `<Explorer>` is mounted only where `regions.explorer` is `column`
 * or `drawer`, and `frame.ts` answers `hidden` at `compact` — so `touch` was
 * permanently `false` and every one of those branches was unreachable, along
 * with the prose arguing for them.
 *
 * That prose is not simply deleted, because what it argued for was right and is
 * worth being able to find: it described Obsidian mobile's sidebar — the verbs
 * at the *foot* of the panel where a thumb is, the filter as a magnifier that
 * reveals a field rather than a permanent one opening a soft keyboard over the
 * tree it filters. It is in the history, and the reference it was measured
 * against is in `docs/design/obsidian-parity`. What is not kept is code nothing
 * can reach: a phone has no file tree at all (`features/app/frame.ts`), and its
 * browse surface is `FolderView` — a flat listing of the folder you are in,
 * with its own thumb sizing.
 *
 * The one piece of the fork that stays is `frame.closesOnSelect` below, and it
 * stays for the reason `frame.ts` gives in the enumeration in its own header:
 * that is `AppFrame`'s API, held by callers outside this feature, and retiring
 * it is one change made where they are rather than a hole opened here.
 *
 * ## Filtering flattens, deliberately
 *
 * A filtered tree that keeps its hierarchy has to decide what to do with a
 * folder whose name does not match but whose children do, and every answer is
 * confusing: hide it and the matches vanish, show it and the "filtered" tree
 * still contains non-matching rows. So a query switches to a flat ranked list —
 * the same ranking the palette uses, so the two cannot disagree about what
 * "best match" means — and clearing it returns you to the tree with your
 * expansion state untouched.
 */
export function Explorer({
  files,
  contextLabel,
  onOpenPinned,
  onOverlayChange,
  pick: pickProp,
  onPickChange,
  access,
  workspaces,
  activity,
  agents,
}: ExplorerProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const frame = useFrame();
  const {
    descending,
    query,
    setQuery,
    dialog,
    setDialog,
    menu,
    setMenu,
    dropTarget,
    refusal,
    setRefusal,
    setPicked,
    activityOpen,
    setActivityOpen,
    agentsOpen,
    setAgentsOpen,
    rows,
    onPick,
    matches,
    selectedFolder,
    select,
    openMenu,
    background,
    runAction,
    dragHandlers,
    counts,
    activityLabel,
    markedPaths,
    agentMarks,
    agentsLabel,
    sheetLift,
    closeFilter,
  } = useExplorer({
    files,
    contextLabel,
    onOpenPinned,
    onOverlayChange,
    pickProp,
    onPickChange,
    activity,
    agents,
    frame,
  });

  return (
    <View style={styles.explorer} testID="explorer">
      <ExplorerToolbar
        files={files}
        selectedFolder={selectedFolder}
        setDialog={setDialog}
        descending={descending}
        query={query}
        setQuery={setQuery}
        closeFilter={closeFilter}
      />

      <ExplorerTree
        files={files}
        query={query}
        contextLabel={contextLabel}
        matches={matches}
        rows={rows}
        select={select}
        setPicked={setPicked}
        openMenu={openMenu}
        onPick={onPick}
        dragHandlers={dragHandlers}
        dropTarget={dropTarget}
        markedPaths={markedPaths}
        agentMarks={agentMarks}
        background={background}
      />

      <ExplorerFoot
        activity={activity}
        activityLabel={activityLabel}
        activityOpen={activityOpen}
        setActivityOpen={setActivityOpen}
        agents={agents}
        agentsLabel={agentsLabel}
        agentsOpen={agentsOpen}
        setAgentsOpen={setAgentsOpen}
        counts={counts}
      />

      {/*
        Under the counts rather than over them, and that is the order of the two
        scopes rather than a preference. The counts line is about *this tree*:
        how much of the context you are in has been read. The row below it is
        about which context that is and which others you can reach — a wider
        fact, and the widest fact in a column reads as its footer. Reversed, the
        counts line would sit between two pieces of navigation and read as a
        caption on the workspace above it, which is a sentence about the wrong
        thing.
      */}
      {workspaces}

      {refusal !== null ? (
        <View style={styles.refusal}>
          <Text variant="hint" style={styles.refusalText}>
            {refusal}
          </Text>
          <PressRow
            accessibilityLabel="Dismiss"
            onPress={() => setRefusal(null)}
            radius={radii.sm}
            style={styles.refusalDismiss}
            hoverStyle={styles.matchHover}
          >
            <Icon name="close" size={13} color={colors.warnText} />
          </PressRow>
        </View>
      ) : null}

      <ExplorerFootLists
        files={files}
        access={access}
        activity={activity}
        activityOpen={activityOpen}
        setActivityOpen={setActivityOpen}
        agents={agents}
        agentsLabel={agentsLabel}
        agentsOpen={agentsOpen}
        setAgentsOpen={setAgentsOpen}
        sheetLift={sheetLift}
      />

      {menu !== null ? (
        <Menu
          items={menu.items}
          anchor={menu.anchor}
          title={menu.title}
          onSelect={(id) => {
            const target = menu.target;
            setMenu(null);
            runAction(id, target);
          }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}

      <ExplorerDialogs
        files={files}
        dialog={dialog}
        onClose={() => setDialog(null)}
        access={access}
      />
    </View>
  );
}

/**
 * Re-exported, not declared. The union moved to `actions.ts`, beside the
 * dispatcher whose output it is; every existing importer of
 * `files/Explorer` keeps working unchanged.
 */
export type { Dialog } from "./actions";

/**
 * The dialogs the tree can raise — see `explorer/ExplorerDialogs.tsx`.
 * Re-exported so every existing importer of `files/Explorer` keeps working.
 */
export { ExplorerDialogs } from "./explorer/ExplorerDialogs";
