import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors, layout, radii } from "../../design/tokens";
import { PaneHead } from "../ConsoleShell";
import { atName } from "../format";
import { loadedFolders, type FileBrowser } from "../files/browser";
import { Confirm, DeleteForever, MovePicker, NamePrompt } from "../files/Dialogs";
import { FileTree } from "../files/FileTree";
import { NoteEditor } from "../files/NoteEditor";
import { baseName, formatBytes, parentPath, restoreTargetFor } from "../files/paths";
import { buildTreeRows, findEntry, type TreeRow } from "../files/tree";
import type { Visibility } from "../files/types";
import { selectedContext, type ConsoleData } from "../types";

/**
 * Browse — the file editor.
 *
 * Plain markdown, exactly as it sits in the customer's bucket, with the
 * operations somebody would reach for in Obsidian: create, rename, move,
 * duplicate, copy/paste, archive, delete, and change what a note is visible to.
 *
 * The layout is the mockup's `.browse` grid — a 246px tree beside the note —
 * with a toolbar above the tree and the selected thing's actions above the
 * editor. Everything that can go wrong shows up in one notice line rather than
 * as scattered inline errors, so there is one place to look.
 *
 * The pane holds only dialog state. Everything else lives in the `FileBrowser`
 * it is handed, which is either the live one or the landing page's read-only
 * demo — the components cannot tell, which is what keeps the marketing page
 * honest.
 */
type Dialog =
  | { kind: "newNote"; folder: string }
  | { kind: "newFolder"; folder: string }
  | { kind: "rename"; path: string }
  | { kind: "move"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "delete"; path: string; isFolder: boolean }
  | null;

export function BrowsePane({
  data,
  /**
   * Opens this context's settings — the storage binding and the ingestion
   * rules. Absent where there is nowhere to go, and the gear is then not
   * rendered rather than rendered dead.
   */
  onOpenSettings,
}: {
  data: ConsoleData;
  onOpenSettings?: () => void;
}) {
  const { width } = useWindowDimensions();
  const narrow = width < layout.narrowBreakpoint;
  const current = selectedContext(data);
  const files = data.files;
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

  const selectedRow = rows.find((row) => row.path === files.selectedPath) ?? null;
  const selectedFolder =
    selectedRow?.kind === "folder" ? selectedRow.path : parentPath(files.selectedPath ?? "");

  const storageLabel = data.storage
    ? `${shortProvider(data.storage.provider)} · ${data.storage.bucket}`
    : "no bucket connected";

  /**
   * A context with nowhere to keep notes.
   *
   * This is a legitimate state — onboarding offers "I'll do this later" rather
   * than trapping somebody in a credential form thirty seconds into their first
   * session — but it is one they have to be able to *see*. A grey chip reading
   * "no bucket connected", sitting among other grey chips, is not seeing it:
   * nothing in this pane can work until a bucket is bound, and an empty tree
   * with no explanation reads as broken rather than as unfinished.
   *
   * Not shown while the binding is still loading. "Not loaded yet" is not "not
   * connected" — the same distinction the rest of the console keeps.
   */
  const noBucket = data.storage === null && !data.loading;

  const manifestBroken = files.listings[""]?.manifestUsable === false;

  return (
    <View>
      <PaneHead
        title={`Browse ${atName(current?.slug ?? "your context")}`}
        description="Plain markdown, exactly as it sits in your bucket. Edit it here or in Obsidian — it is the same file either way."
        trailing={
          /*
            The storage chip, and the way into everything behind it. A person
            reading "R2 · brain" and wanting to change it is already looking
            here — making them find a separate top-level pane to rotate the key
            that chip is describing was the wrong shape.
          */
          <View style={styles.headActions}>
            <Pill tone={noBucket ? "warn" : "neutral"} leading={noBucket ? <Dot tone="warn" /> : undefined}>
              {storageLabel}
            </Pill>
            {onOpenSettings ? (
              <PressRow
                accessibilityLabel={`Settings for ${atName(current?.slug ?? "this context")}`}
                onPress={onOpenSettings}
                radius={radii.md}
                style={styles.gear}
                hoverStyle={styles.gearHover}
                testID="browse-settings"
              >
                <Text style={styles.gearGlyph} aria-hidden>
                  ⚙
                </Text>
              </PressRow>
            ) : null}
          </View>
        }
      />

      {files.readOnlyReason !== undefined && !files.canEdit ? (
        <View style={styles.notice}>
          <Text variant="hint">{files.readOnlyReason}</Text>
        </View>
      ) : null}

      {noBucket ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          <Text variant="hint" style={styles.noticeWarnText}>
            No bucket is connected to this context yet, so there is nowhere to keep notes.
            Point it at an S3-compatible bucket you own and everything here starts working —
            your name and your capture address are already yours.
          </Text>
          {onOpenSettings ? (
            <Button
              label="Connect a bucket"
              onPress={onOpenSettings}
              style={styles.dismiss}
              testID="browse-connect-storage"
            />
          ) : null}
        </View>
      ) : null}

      {manifestBroken ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          <Text variant="hint" style={styles.noticeWarnText}>
            privacy.md is missing or could not be read, so everything is treated as
            private and nothing can be shared until it is fixed. Nothing is exposed by
            this — it fails closed. Write a valid privacy.md at the root of the bucket,
            or ask a connected AI client to, and sharing works again.
          </Text>
        </View>
      ) : null}

      {files.notice !== null ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          <Text variant="hint" style={styles.noticeWarnText}>
            {files.notice}
          </Text>
          <Button label="Dismiss" onPress={files.dismissNotice} style={styles.dismiss} />
        </View>
      ) : null}

      <View style={[styles.browse, narrow && styles.browseNarrow]}>
        <View style={[styles.treeColumn, narrow && styles.treeColumnNarrow]}>
          {files.canEdit ? (
            <View style={styles.toolbar}>
              <Button
                label="New note"
                onPress={() => setDialog({ kind: "newNote", folder: selectedFolder })}
              />
              <Button
                label="New folder"
                onPress={() => setDialog({ kind: "newFolder", folder: selectedFolder })}
              />
              {files.clipboard !== null ? (
                <Button
                  label={`Paste ${files.clipboard.name}`}
                  onPress={() => files.paste(selectedFolder)}
                />
              ) : null}
            </View>
          ) : null}

          <ScrollView
            style={styles.tree}
            contentContainerStyle={styles.treeContent}
            role="tree"
            aria-label="Folders and notes"
          >
            {files.loading ? (
              <Text variant="treeMeta" style={styles.treeStatus}>
                Reading your bucket…
              </Text>
            ) : (
              <FileTree
                rows={rows}
                canEdit={files.canEdit}
                onSelect={files.select}
                onToggle={(path) => {
                  files.toggleFolder(path);
                  files.select(path);
                }}
                onCycleVisibility={(row) => cycleVisibility(files, row)}
              />
            )}
          </ScrollView>

          <Text variant="treeMeta" style={styles.legend}>
            A folder shows its default. A file is marked only where it differs from that.
          </Text>
        </View>

        <View style={styles.note}>
          {selectedRow === null ? (
            <Text variant="paneSub">Choose a note to read or edit it.</Text>
          ) : (
            <>
              <View style={styles.noteHead}>
                <Text variant="noteTitle" role="heading" aria-level={3} numberOfLines={1}>
                  {baseName(selectedRow.path)}
                </Text>
                <View style={styles.noteMeta}>
                  <Pill tone="neutral">{parentPath(selectedRow.path) || "/"}</Pill>
                  <Pill tone={visibilityTone(files, selectedRow)}>
                    {describeSelectedVisibility(files, selectedRow)}
                  </Pill>
                  {selectedRow.size !== undefined ? (
                    <Text variant="meta">{formatBytes(selectedRow.size)}</Text>
                  ) : null}
                </View>
              </View>

              {files.canEdit ? (
                <View style={styles.actions}>
                  <Button
                    label="Rename"
                    disabled={files.busy || selectedRow.readOnly}
                    onPress={() => setDialog({ kind: "rename", path: selectedRow.path })}
                  />
                  <Button
                    label="Move"
                    disabled={files.busy || selectedRow.readOnly}
                    onPress={() => setDialog({ kind: "move", path: selectedRow.path })}
                  />
                  <Button
                    label="Duplicate"
                    disabled={files.busy || selectedRow.readOnly}
                    onPress={() => files.duplicate(selectedRow.path)}
                  />
                  <Button
                    label="Copy"
                    disabled={selectedRow.readOnly}
                    onPress={() => files.copy(selectedRow.path)}
                  />
                  <Button
                    label="Cut"
                    disabled={files.busy || selectedRow.readOnly}
                    onPress={() => files.cut(selectedRow.path)}
                  />
                  {/* Archive first, and permanent deletion behind a "…". The
                      recoverable action is the easy one on purpose — and for
                      something already archived, the easy action is undoing it.
                      The archive keeps the original path inside its timestamped
                      folder precisely so this is a move, not a guess. */}
                  {restoreTargetFor(selectedRow.path) !== null ? (
                    <Button
                      label="Restore"
                      disabled={files.busy}
                      onPress={() =>
                        files.move(
                          selectedRow.path,
                          parentPath(restoreTargetFor(selectedRow.path)!),
                        )
                      }
                    />
                  ) : (
                    <Button
                      label="Archive"
                      disabled={files.busy || selectedRow.readOnly}
                      onPress={() => setDialog({ kind: "archive", path: selectedRow.path })}
                    />
                  )}
                  <Button
                    label="Delete…"
                    variant="danger"
                    disabled={files.busy || selectedRow.readOnly}
                    onPress={() =>
                      setDialog({
                        kind: "delete",
                        path: selectedRow.path,
                        isFolder: selectedRow.kind === "folder",
                      })
                    }
                  />
                </View>
              ) : null}

              {selectedRow.kind === "folder" ? (
                <FolderSummary
                  row={selectedRow}
                  canEdit={files.canEdit}
                  onSetVisibility={(visibility) =>
                    files.setVisibility(selectedRow.path, "folder", visibility)
                  }
                />
              ) : (
                <NoteEditor
                  state={files.editor}
                  canEdit={files.canEdit}
                  onChange={files.setDraft}
                  onSave={files.save}
                  onDiscard={files.discard}
                  onUseTheirs={files.useTheirs}
                  onKeepMine={files.keepMine}
                />
              )}
            </>
          )}
        </View>
      </View>

      {dialog?.kind === "newNote" ? (
        <NamePrompt
          title="New note"
          description={`It will be created in ${dialog.folder || "the root of your context"} as markdown.`}
          confirmLabel="Create"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            files.createNote(dialog.folder, name);
          }}
        />
      ) : null}

      {dialog?.kind === "newFolder" ? (
        <NamePrompt
          title="New folder"
          description="A bucket has no empty folders, so this also writes a README.md inside it — visible in Obsidian and to every other tool that reads your bucket."
          confirmLabel="Create"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            files.createFolder(dialog.folder, name);
          }}
        />
      ) : null}

      {dialog?.kind === "rename" ? (
        <NamePrompt
          title="Rename"
          initialValue={baseName(dialog.path)}
          confirmLabel="Rename"
          onCancel={() => setDialog(null)}
          onConfirm={(name) => {
            setDialog(null);
            files.rename(dialog.path, name);
          }}
        />
      ) : null}

      {dialog?.kind === "move" ? (
        <MovePicker
          title={`Move ${baseName(dialog.path)}`}
          folders={loadedFolders(files.listings).filter(
            (folder) =>
              dialog.path !== folder && !folder.startsWith(`${dialog.path}/`),
          )}
          currentFolder={parentPath(dialog.path)}
          onCancel={() => setDialog(null)}
          onConfirm={(folder) => {
            setDialog(null);
            files.move(dialog.path, folder);
          }}
        />
      ) : null}

      {dialog?.kind === "archive" ? (
        <Confirm
          title="Archive"
          body={`${dialog.path} moves into 4-archive/ with its original path kept inside, so you can move it straight back. Nothing is deleted.`}
          confirmLabel="Archive it"
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            files.archive(dialog.path);
          }}
        />
      ) : null}

      {dialog?.kind === "delete" ? (
        <DeleteForever
          path={dialog.path}
          isFolder={dialog.isFolder}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            files.destroy(dialog.path);
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * A folder has no body to edit, so its pane explains what its default means
 * and offers the one control that matters.
 */
function FolderSummary({
  row,
  canEdit,
  onSetVisibility,
}: {
  row: TreeRow;
  canEdit: boolean;
  onSetVisibility: (visibility: Visibility) => void;
}) {
  const current: Visibility = row.marker ?? "private";
  return (
    <View style={styles.folder}>
      <Text variant="paneSub">
        {current === "team"
          ? "Everything in this folder is visible to the people you have granted team access, unless a note is held back as an exception."
          : "Everything in this folder is yours alone, unless a note is shared as an exception."}
      </Text>
      {canEdit ? (
        <Button
          label={
            current === "team"
              ? "Make this folder private"
              : "Share this folder with your team"
          }
          variant="white"
          onPress={() => onSetVisibility(current === "team" ? "private" : "team")}
        />
      ) : null}
      <Text variant="treeMeta">
        team means named people you granted access to. There is no public tier.
      </Text>
    </View>
  );
}

/** The inline control: private ↔ team, through the privacy manifest. */
function cycleVisibility(files: FileBrowser, row: TreeRow): void {
  if (row.readOnly) return;
  const currentValue = row.marker ?? inheritedOf(files, row.path);
  files.setVisibility(
    row.path,
    row.kind === "folder" ? "folder" : "file",
    currentValue === "team" ? "private" : "team",
  );
}

function inheritedOf(files: FileBrowser, path: string): Visibility {
  return findEntry(files.listings, path)?.inherited ?? "private";
}

function visibilityTone(files: FileBrowser, row: TreeRow): "ok" | "neutral" {
  const value = row.marker ?? inheritedOf(files, row.path);
  return value === "team" ? "ok" : "neutral";
}

/**
 * The selected thing's visibility, said in full.
 *
 * The tree marks only exceptions; here there is room to be explicit, so a note
 * that follows its folder says so rather than looking simply unlabelled.
 */
function describeSelectedVisibility(files: FileBrowser, row: TreeRow): string {
  if (row.readOnly) return "the access map";
  if (row.kind === "folder") return `${row.marker ?? "private"} by default`;
  if (row.marker !== undefined) return `${row.marker} — set on this note`;
  return `${inheritedOf(files, row.path)} — follows its folder`;
}

/** "Cloudflare R2" reads as "R2" in a pill that has to fit beside a title. */
function shortProvider(provider: string): string {
  if (/r2/i.test(provider)) return "R2";
  if (/s3/i.test(provider)) return "S3";
  if (/b2|backblaze/i.test(provider)) return "B2";
  return provider;
}

const styles = StyleSheet.create({
  headActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  /** The gear beside the storage chip — `.mini`'s materials at icon size. */
  gear: {
    width: 28,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface3,
  },
  gearHover: { borderColor: "rgba(255,255,255,.26)" },
  gearGlyph: { fontSize: 13, lineHeight: 15, color: colors.text2 },

  /** `.browse` — `grid-template-columns: 246px 1fr` */
  browse: { flexDirection: "row", gap: 16 },
  browseNarrow: { flexDirection: "column" },

  treeColumn: { width: layout.treeWidth, flexGrow: 0, flexShrink: 0, gap: 9 },
  treeColumnNarrow: { width: "100%" },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: 8 },

  /** `.tree` */
  tree: {
    maxHeight: 432,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
  },
  treeContent: { padding: 9 },
  treeStatus: { padding: 8 },
  legend: { paddingHorizontal: 2 },

  /** `.note` */
  note: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    paddingVertical: 20,
    paddingHorizontal: 22,
    gap: 14,
  },
  noteHead: { gap: 6 },
  noteMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 9 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  folder: { gap: 14 },

  notice: {
    marginBottom: 14,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  noticeWarn: { backgroundColor: colors.warnWash, borderColor: colors.warnBorder },
  noticeWarnText: { color: colors.warnText, flexGrow: 1, flexShrink: 1 },
  dismiss: { flexGrow: 0, flexShrink: 0 },
});
