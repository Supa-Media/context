import { useCallback, useRef, useState } from "react";
import { View } from "react-native";
import { Menu } from "../../../design/components/Menu";
import { Text } from "../../../design/components/Text";
import { isApplePlatform } from "../../../design/applePlatform";
import { describeBinding } from "../../../design/keymap";
import { useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../browser";
import { setListingOrder } from "../listingOrder";
import type { MenuItem } from "../menu";
import { baseName, folderLabel } from "../paths";
import { IconButton } from "./IconButton";
import { makeStyles } from "./styles";
import type { ExplorerState } from "./useExplorer";
import { useMapRoute } from "../../map/live/MapRouteContext";

type NewId = "new-note" | "new-folder" | "new-drawing";
type ViewId = "sort-asc" | "sort-desc" | "collapse";

/**
 * The column's header: `Notes`, then three buttons that never move.
 *
 * ## It is the same header with the pointer over it and without
 *
 * It used to draw on approach. Entering the column faded `Notes` out, gave an
 * invisible filter field underneath it a box, and faded in two more buttons —
 * so the header redrew every time somebody reached for a note, and two of its
 * controls could not be found by anyone who had not moused over the tree. The
 * owner's word for the fix was that the UI needs to stay the same, and the
 * design they chose (2026-09-26) is this one: a label and three buttons, drawn
 * once. Hovering a button lights that button and nothing else.
 *
 * - **No filter field.** The magnifier that opened one went when search
 *   became one bar (leadership weekly, 2026-10-17): ⌘K's Tab narrows the
 *   tree instead, and while it is narrowed the label's place says so, with
 *   Clear.
 * - **New** is a menu — note, folder, drawing — naming the folder it makes
 *   them in. ⌘N still makes a note in one step.
 * - **View** is a menu — sort order, and collapse every folder. Collapse-all
 *   used to be a button drawn as a pane with a band, which read as "hide the
 *   sidebar" (that is ⌘B and the top bar's toggle); in a menu it has a name.
 *
 * Sort and collapse are about the *panel* rather than about the context, so
 * View is not gated on `canEdit`; New is, and a reader's header is two buttons.
 *
 * ## In the title row, it has no label
 *
 * Where the title bar has a row over the column, these tools are drawn there
 * (`inBar`, see `columnTools.ts`): the owner's option A (2026-09-28), which
 * fills what was an empty row and lets the tree start one row higher. There
 * is no `Notes` in that row, because the tree under it says what it is. The
 * narrowed line takes the label's place, which up there is the room before
 * the buttons.
 */
export function ExplorerToolbar({
  files,
  selectedFolder,
  setDialog,
  descending,
  query,
  closeFilter,
  inBar = false,
}: {
  files: FileBrowser;
  selectedFolder: ExplorerState["selectedFolder"];
  setDialog: ExplorerState["setDialog"];
  descending: ExplorerState["descending"];
  query: string;
  closeFilter: ExplorerState["closeFilter"];
  /** Drawn in the title row over the column rather than at its head. */
  inBar?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<"new" | "view" | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  const newRef = useRef<View>(null);
  const viewRef = useRef<View>(null);

  /** A query from ⌘K's Tab is narrowing the tree. */
  const filtering = query !== "";

  /**
   * Open a menu under its own button.
   *
   * Measured at press time, as `CreateButton` does and for its reason: the
   * anchor is a hint, `measureInWindow` answers asynchronously (and never
   * under jsdom), so the menu opens outside the callback and `Menu` falls
   * back to its own margin when no measurement landed.
   */
  const openMenu = useCallback((which: "new" | "view") => {
    const ref = which === "new" ? newRef : viewRef;
    ref.current?.measureInWindow((x, y, _width, height) => {
      setAnchor({ x, y: y + height + 4 });
    });
    setOpen(which);
  }, []);

  const dismiss = useCallback(() => {
    setOpen(null);
    setAnchor(undefined);
  }, []);

  const where = selectedFolder === "" ? "the top level" : folderLabel(baseName(selectedFolder));
  const newNoteChord = describeBinding("newNote", isApplePlatform());
  const newItems: MenuItem<NewId>[] = [
    {
      id: "new-note",
      label: "New note",
      detail: `In ${where}.`,
      ...(newNoteChord === null ? {} : { shortcut: newNoteChord }),
      testID: "explorer-new-note",
    },
    { id: "new-folder", label: "New folder", testID: "explorer-new-folder" },
    { id: "new-drawing", label: "New drawing", testID: "explorer-new-drawing" },
  ];
  const viewItems: MenuItem<ViewId>[] = [
    { id: "sort-asc", label: "Sort A to Z", checked: !descending, testID: "explorer-sort-asc" },
    { id: "sort-desc", label: "Sort Z to A", checked: descending, testID: "explorer-sort-desc" },
    {
      id: "collapse",
      label: "Collapse all folders",
      separatorBefore: true,
      testID: "explorer-collapse",
    },
  ];

  const chooseNew = (id: NewId) => {
    dismiss();
    if (id === "new-note") files.createUntitled(selectedFolder, "note");
    if (id === "new-drawing") files.createUntitled(selectedFolder, "drawing");
    if (id === "new-folder") setDialog({ kind: "newFolder", folder: selectedFolder });
  };

  const chooseView = (id: ViewId) => {
    dismiss();
    if (id === "sort-asc") setListingOrder(false);
    if (id === "sort-desc") setListingOrder(true);
    if (id === "collapse") files.collapseAll();
  };

  const mapRoute = useMapRoute();
  return (
    <View style={inBar ? styles.toolbarInBar : styles.toolbar} testID="explorer-header">
      {filtering ? (
        /*
          The tree narrowed by ⌘K's Tab (`treeFilter.ts`): one plain line in
          the label's place saying what it shows, and Clear (board A3). The
          tree's own field and magnifier went when search became one bar
          (leadership weekly, 2026-10-17).
        */
        <View style={[styles.narrowed, inBar && styles.noDrag]} testID="explorer-narrowed">
          <Text variant="treeMeta" numberOfLines={1} style={styles.narrowedText}>
            {`Names with “${query}”`}
          </Text>
          <Text
            variant="treeMeta"
            role="button"
            accessibilityLabel="Clear, and show the whole tree"
            onPress={closeFilter}
            style={styles.narrowedClear}
            testID="explorer-filter-clear"
          >
            Clear
          </Text>
        </View>
      ) : (
        <View style={styles.label}>{inBar ? null : <Text variant="eyebrow">Notes</Text>}</View>
      )}
      <View style={[styles.tools, inBar && styles.noDrag]}>
        {/*
          Up in the title row the field shares a narrow run with the window's
          buttons, so while it is open New and View step aside for it.
        */}
        {files.canEdit && !(inBar && filtering) ? (
          <View ref={newRef}>
            <IconButton
              label="New"
              icon="plus"
              menu
              on={open === "new"}
              onPress={() => openMenu("new")}
              testID="explorer-new"
            />
          </View>
        ) : null}
        {inBar && filtering ? null : (
          <View ref={viewRef}>
            <IconButton
              label="View options"
              icon="more"
              menu
              on={open === "view"}
              onPress={() => openMenu("view")}
              testID="explorer-view"
            />
          </View>
        )}
        {/*
          The live map: a page in the document slot (`?map=1`), lit while it
          is open, and the same press closes it. Only inside the console
          layout, which is the only place that provides the route.
        */}
        {mapRoute !== undefined && !(inBar && filtering) ? (
          <IconButton
            label={mapRoute.open ? "Close the map" : "Map"}
            icon="liveMap"
            on={mapRoute.open}
            onPress={mapRoute.toggle}
            testID="explorer-map"
          />
        ) : null}
      </View>

      {open === "new" ? (
        <Menu<NewId>
          {...(anchor === undefined ? {} : { anchor })}
          title="New"
          items={newItems}
          onSelect={chooseNew}
          onDismiss={dismiss}
        />
      ) : null}
      {open === "view" ? (
        <Menu<ViewId>
          {...(anchor === undefined ? {} : { anchor })}
          title="View"
          items={viewItems}
          onSelect={chooseView}
          onDismiss={dismiss}
        />
      ) : null}
    </View>
  );
}
