import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, TextInput, View } from "react-native";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { colors, radii, space } from "../../design/tokens";
import { useFrame } from "../../app/AppFrame";
import { loadedFolders, type FileBrowser } from "./browser";
import { Confirm, DeleteForever, MovePicker, NamePrompt } from "./Dialogs";
import { FileTree } from "./FileTree";
import { baseName, parentPath } from "./paths";
import { itemsFromListings, rank } from "./palette";
import { buildTreeRows, type TreeRow } from "./tree";
import type { Visibility } from "./types";

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
 * a long press under a thumb. What earns permanent space instead is the filter,
 * which is the thing you actually reach for many times an hour.
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
}: {
  files: FileBrowser;
  /** "@seyi" — named in the empty state so it is obvious whose tree this is. */
  contextLabel: string;
}) {
  const frame = useFrame();
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);

  const rows = useMemo(
    () =>
      buildTreeRows({
        listings: files.listings,
        expanded: files.expanded,
        selectedPath: files.selectedPath,
      }),
    [files.expanded, files.listings, files.selectedPath],
  );

  const matches = useMemo(() => {
    if (query.trim() === "") return null;
    return rank(query, itemsFromListings(files.listings));
  }, [query, files.listings]);

  const selectedRow = rows.find((row) => row.path === files.selectedPath) ?? null;
  const selectedFolder =
    selectedRow?.kind === "folder" ? selectedRow.path : parentPath(files.selectedPath ?? "");

  /** Choosing a note on a phone has to get the drawer out of the way. */
  const select = (path: string) => {
    files.select(path);
    if (frame.closesOnSelect) frame.closeDrawer();
  };

  const counts = countLoaded(files);

  return (
    <View style={styles.explorer}>
      <View style={styles.toolbar}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Filter"
          placeholderTextColor={colors.muted}
          style={styles.filter}
          accessibilityLabel="Filter notes and folders"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          testID="explorer-filter"
        />
        {query !== "" ? (
          <IconButton label="Clear the filter" glyph="×" onPress={() => setQuery("")} />
        ) : null}
        {files.canEdit ? (
          <>
            <IconButton
              label="New note"
              glyph="＋"
              onPress={() => setDialog({ kind: "newNote", folder: selectedFolder })}
              testID="explorer-new-note"
            />
            <IconButton
              label="New folder"
              glyph="⊞"
              onPress={() => setDialog({ kind: "newFolder", folder: selectedFolder })}
              testID="explorer-new-folder"
            />
          </>
        ) : null}
      </View>

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
              Nothing here matches “{query}”. Only folders you have opened are searched — the
              rest of {contextLabel} has not been read yet.
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
            canEdit={files.canEdit}
            onSelect={select}
            onToggle={(path) => {
              files.toggleFolder(path);
              files.select(path);
            }}
            onCycleVisibility={(row) => cycleVisibility(files, row)}
          />
        )}
      </ScrollView>

      <View style={styles.foot}>
        <Text variant="treeMeta" numberOfLines={1}>
          {counts}
        </Text>
      </View>

      <ExplorerDialogs files={files} dialog={dialog} onClose={() => setDialog(null)} />
    </View>
  );
}

/* -------------------------------------------------------------------------- */

export type Dialog =
  | { kind: "newNote"; folder: string }
  | { kind: "newFolder"; folder: string }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "delete"; path: string; isFolder: boolean }
  | null;

/**
 * The dialogs the tree can raise.
 *
 * Separated so both the tree and the editor's own menu can drive the same set
 * without either owning it — and so the one dialog that must never become a
 * boolean on another, `DeleteForever`, stays visibly its own thing.
 */
export function ExplorerDialogs({
  files,
  dialog,
  onClose,
}: {
  files: FileBrowser;
  dialog: Dialog;
  onClose: () => void;
}) {
  if (dialog === null) return null;

  switch (dialog.kind) {
    case "newNote":
      return (
        <NamePrompt
          title="New note"
          description={`It will be created in ${dialog.folder || "the root of your context"} as markdown.`}
          confirmLabel="Create"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.createNote(dialog.folder, name);
          }}
        />
      );
    case "newFolder":
      return (
        <NamePrompt
          title="New folder"
          description="A bucket has no empty folders, so this also writes a README.md inside it — visible in Obsidian and to every other tool that reads your bucket."
          confirmLabel="Create"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.createFolder(dialog.folder, name);
          }}
        />
      );
    case "rename":
      return (
        <NamePrompt
          title="Rename"
          initialValue={baseName(dialog.path)}
          confirmLabel="Rename"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.rename(dialog.path, name);
          }}
        />
      );
    case "move":
      return (
        <MovePicker
          title={`Move ${baseName(dialog.path)}`}
          folders={loadedFolders(files.listings).filter(
            (folder) => dialog.path !== folder && !folder.startsWith(`${dialog.path}/`),
          )}
          currentFolder={parentPath(dialog.path)}
          onCancel={onClose}
          onConfirm={(folder) => {
            onClose();
            files.move(dialog.path, folder);
          }}
        />
      );
    case "archive":
      return (
        <Confirm
          title="Archive"
          body={`${dialog.path} moves into 4-archive/ with its original path kept inside, so you can move it straight back. Nothing is deleted.`}
          confirmLabel="Archive it"
          onCancel={onClose}
          onConfirm={() => {
            onClose();
            files.archive(dialog.path);
          }}
        />
      );
    case "delete":
      return (
        <DeleteForever
          path={dialog.path}
          isFolder={dialog.isFolder}
          onCancel={onClose}
          onConfirm={() => {
            onClose();
            files.destroy(dialog.path);
          }}
        />
      );
  }
}

function IconButton({
  label,
  glyph,
  onPress,
  testID,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={onPress}
      radius={radii.md}
      style={styles.iconButton}
      hoverStyle={styles.iconButtonHover}
      testID={testID}
    >
      <Text style={styles.iconGlyph} aria-hidden>
        {glyph}
      </Text>
    </PressRow>
  );
}

/**
 * What the foot says.
 *
 * Only what has actually been read. A tree that lazily loads one folder at a
 * time cannot honestly print a total for the bucket, and inventing one is the
 * same failure the console's stat tiles were removed for.
 */
function countLoaded(files: FileBrowser): string {
  let notes = 0;
  let folders = 0;
  for (const listing of Object.values(files.listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.kind === "folder") folders += 1;
      else notes += 1;
    }
  }
  if (notes === 0 && folders === 0) return "Nothing read yet";
  return `${notes} note${notes === 1 ? "" : "s"}, ${folders} folder${folders === 1 ? "" : "s"} read`;
}

/** The inline control: private ↔ team, through the privacy manifest. */
function cycleVisibility(files: FileBrowser, row: TreeRow): void {
  if (row.readOnly) return;
  const current = row.marker ?? inheritedOf(files, row.path);
  files.setVisibility(
    row.path,
    row.kind === "folder" ? "folder" : "file",
    current === "team" ? "private" : "team",
  );
}

function inheritedOf(files: FileBrowser, path: string): Visibility {
  for (const listing of Object.values(files.listings)) {
    for (const entry of listing?.entries ?? []) {
      if (entry.path === path) return entry.inherited;
    }
  }
  return "private";
}

const styles = StyleSheet.create({
  explorer: { flex: 1, minHeight: 0 },

  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.x2,
    paddingVertical: space.x2,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
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
    fontSize: 12,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  iconButtonHover: { borderColor: colors.lineStrong },
  iconGlyph: { color: colors.text2, fontSize: 13, lineHeight: 15 },

  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingVertical: space.x2, paddingHorizontal: 6 },
  status: { paddingHorizontal: space.x2, paddingVertical: space.x2 },

  match: {
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 1,
    width: "100%",
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
  },
  matchHover: { backgroundColor: colors.surface3 },
  matchOn: { backgroundColor: colors.accentDim },
  matchDetail: { opacity: 0.85 },

  foot: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: space.x3,
    paddingVertical: 5,
  },
});
