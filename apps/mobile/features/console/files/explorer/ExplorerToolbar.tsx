import { useCallback, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { Menu } from "../../../design/components/Menu";
import { Text } from "../../../design/components/Text";
import { isApplePlatform } from "../../../design/applePlatform";
import { describeBinding } from "../../../design/keymap";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../browser";
import { setListingOrder } from "../listingOrder";
import type { MenuItem } from "../menu";
import { baseName, folderLabel } from "../paths";
import { IconButton } from "./IconButton";
import { makeStyles } from "./styles";
import type { ExplorerState } from "./useExplorer";

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
 * - **Filter** swaps the label for a field, on a press rather than on
 *   approach. It stays lit while a query is filtering, so a shortened tree
 *   always has a visible reason, and pressing it lit (or Escape in the
 *   field) clears the query and puts the label back.
 * - **New** is a menu — note, folder, drawing — naming the folder it makes
 *   them in. ⌘N still makes a note in one step.
 * - **View** is a menu — sort order, and collapse every folder. Collapse-all
 *   used to be a button drawn as a pane with a band, which read as "hide the
 *   sidebar" (that is ⌘B and the top bar's toggle); in a menu it has a name.
 *
 * Sort and collapse are about the *panel* rather than about the context, so
 * View is not gated on `canEdit`; New is, and a reader's header is two buttons.
 */
export function ExplorerToolbar({
  files,
  selectedFolder,
  setDialog,
  descending,
  query,
  setQuery,
  closeFilter,
}: {
  files: FileBrowser;
  selectedFolder: ExplorerState["selectedFolder"];
  setDialog: ExplorerState["setDialog"];
  descending: ExplorerState["descending"];
  query: string;
  setQuery: ExplorerState["setQuery"];
  closeFilter: ExplorerState["closeFilter"];
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [filterOpen, setFilterOpen] = useState(false);
  const [open, setOpen] = useState<"new" | "view" | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | undefined>(undefined);
  const newRef = useRef<View>(null);
  const viewRef = useRef<View>(null);
  /**
   * When an empty field last put itself away on blur.
   *
   * Pressing the lit magnifier blurs the field on mousedown, before the press
   * lands — so the blur has already closed it, and the press would read
   * "closed" and open it again. A press within a moment of that blur is the
   * same gesture, and is left as the close it was.
   */
  const blurClosedAt = useRef(0);

  /** A query that is filtering keeps its field, whoever asked for it. */
  const filtering = filterOpen || query !== "";

  const putFilterAway = useCallback(() => {
    closeFilter();
    setFilterOpen(false);
  }, [closeFilter]);

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

  return (
    <View style={styles.toolbar} testID="explorer-header">
      {filtering ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Filter"
          placeholderTextColor={colors.muted}
          /*
            Autofocused because it has just been asked for: this field is
            mounted by a press on the magnifier, so the caret belongs in it.
            (The old field was permanent and could not do this without
            stealing the caret on every mount.)
          */
          autoFocus={filterOpen}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Escape") putFilterAway();
          }}
          /* An empty field somebody has left goes back to being the label. */
          onBlur={() => {
            if (query !== "") return;
            blurClosedAt.current = Date.now();
            setFilterOpen(false);
          }}
          style={styles.filter}
          accessibilityLabel="Filter notes and folders"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          testID="explorer-filter"
        />
      ) : (
        <View style={styles.label}>
          <Text variant="eyebrow">Notes</Text>
        </View>
      )}
      <View style={styles.tools}>
        <IconButton
          label={filtering ? "Clear the filter" : "Filter notes and folders"}
          icon="search"
          on={filtering}
          onPress={() => {
            if (filtering) putFilterAway();
            else if (Date.now() - blurClosedAt.current > 400) setFilterOpen(true);
          }}
          testID="explorer-filter-toggle"
        />
        {files.canEdit ? (
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
