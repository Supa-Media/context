import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, PressRow } from "../../design/components/Button";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors, radii } from "../../design/tokens";
import { PaneHead } from "../ConsoleShell";
import { atName } from "../format";
import type { FileBrowser } from "../files/browser";
import { ExplorerDialogs, type Dialog } from "../files/Explorer";
import { NoteEditor } from "../files/NoteEditor";
import { baseName, formatBytes, parentPath, restoreTargetFor } from "../files/paths";
import { findEntry } from "../files/tree";
import type { FileEntry, Visibility } from "../files/types";
import { selectedContext, type ConsoleData } from "../types";

/**
 * Browse — the note.
 *
 * This pane used to be the whole file editor: a 246px tree beside the note,
 * a "New note / New folder" toolbar above the tree, and a row of seven buttons
 * — Rename, Move, Duplicate, Copy, Cut, Archive, Delete… — permanently
 * occupying the top of every document.
 *
 * The tree has moved out, to `files/Explorer.tsx`, because it is a region of
 * the application frame rather than content inside a pane: that is what lets it
 * be a resizable column on a desktop and a drawer on a phone, and what lets it
 * fill the height instead of scrolling inside a fixed box inside a scrolling
 * page.
 *
 * What is left is the note itself, which is what this pane was always for.
 * The actions remain for now — they are replaced by the row's own context menu
 * and its long-press action sheet — but they are down here beside the thing
 * they act on rather than above it, and the storage chip has moved to the top
 * bar where it describes the context rather than this one view of it.
 */
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
  const current = selectedContext(data);
  const files = data.files;
  const [dialog, setDialog] = useState<Dialog>(null);

  const selected =
    files.selectedPath === null ? null : findEntry(files.listings, files.selectedPath);

  const noBucket = data.storage === null && !data.loading;
  const manifestBroken = files.listings[""]?.manifestUsable === false;

  return (
    <View>
      <PaneHead
        title={`Browse ${atName(current?.slug ?? "your context")}`}
        description="Plain markdown, exactly as it sits in your bucket. Edit it here or in Obsidian — it is the same file either way."
        trailing={
          onOpenSettings ? (
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
          ) : null
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

      <View style={styles.note}>
        {selected === null ? (
          <Text variant="paneSub">Choose a note to read or edit it.</Text>
        ) : (
          <>
            <View style={styles.noteHead}>
              <Text variant="noteTitle" role="heading" aria-level={3} numberOfLines={1}>
                {baseName(selected.path)}
              </Text>
              <View style={styles.noteMeta}>
                <Pill tone="neutral">{parentPath(selected.path) || "/"}</Pill>
                <Pill tone={visibilityTone(selected)}>{describeVisibility(selected)}</Pill>
                {selected.size !== undefined ? (
                  <Text variant="meta">{formatBytes(selected.size)}</Text>
                ) : null}
              </View>
            </View>

            {files.canEdit ? (
              <View style={styles.actions}>
                <Button
                  label="Rename"
                  disabled={files.busy || selected.readOnly}
                  onPress={() => setDialog({ kind: "rename", path: selected.path })}
                />
                <Button
                  label="Move"
                  disabled={files.busy || selected.readOnly}
                  onPress={() => setDialog({ kind: "move", path: selected.path })}
                />
                <Button
                  label="Duplicate"
                  disabled={files.busy || selected.readOnly}
                  onPress={() => files.duplicate(selected.path)}
                />
                {/* Archive first, and permanent deletion behind a "…". The
                    recoverable action is the easy one on purpose — and for
                    something already archived, the easy action is undoing it.
                    The archive keeps the original path inside its timestamped
                    folder precisely so this is a move, not a guess. */}
                {restoreTargetFor(selected.path) !== null ? (
                  <Button
                    label="Restore"
                    disabled={files.busy}
                    onPress={() =>
                      files.move(selected.path, parentPath(restoreTargetFor(selected.path)!))
                    }
                  />
                ) : (
                  <Button
                    label="Archive"
                    disabled={files.busy || selected.readOnly}
                    onPress={() => setDialog({ kind: "archive", path: selected.path })}
                  />
                )}
                <Button
                  label="Delete…"
                  variant="danger"
                  disabled={files.busy || selected.readOnly}
                  onPress={() =>
                    setDialog({
                      kind: "delete",
                      path: selected.path,
                      isFolder: selected.kind === "folder",
                    })
                  }
                />
              </View>
            ) : null}

            {selected.kind === "folder" ? (
              <FolderSummary
                entry={selected}
                canEdit={files.canEdit}
                onSetVisibility={(visibility) =>
                  files.setVisibility(selected.path, "folder", visibility)
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

      <ExplorerDialogs files={files} dialog={dialog} onClose={() => setDialog(null)} />
    </View>
  );
}

/**
 * A folder has no body to edit, so its pane explains what its default means
 * and offers the one control that matters.
 */
function FolderSummary({
  entry,
  canEdit,
  onSetVisibility,
}: {
  entry: FileEntry;
  canEdit: boolean;
  onSetVisibility: (visibility: Visibility) => void;
}) {
  const current = entry.visibility;
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
            current === "team" ? "Make this folder private" : "Share this folder with your team"
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

function visibilityTone(entry: FileEntry): "ok" | "neutral" {
  return entry.visibility === "team" ? "ok" : "neutral";
}

/**
 * The selected thing's visibility, said in full.
 *
 * The tree marks only exceptions; here there is room to be explicit, so a note
 * that follows its folder says so rather than looking simply unlabelled.
 */
function describeVisibility(entry: FileEntry): string {
  if (entry.readOnly) return "the access map";
  if (entry.kind === "folder") return `${entry.visibility} by default`;
  if (entry.exception) return `${entry.visibility} — set on this note`;
  return `${entry.inherited} — follows its folder`;
}

const styles = StyleSheet.create({
  /** The gear beside the title — `.mini`'s materials at icon size. */
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

  note: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.card,
    backgroundColor: colors.surface2,
    padding: 16,
    gap: 14,
  },
  noteHead: { gap: 8 },
  noteMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  folder: { gap: 14 },

  notice: {
    marginBottom: 14,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    backgroundColor: colors.hintWash,
    gap: 10,
  },
  noticeWarn: { borderColor: colors.warnBorder, backgroundColor: colors.warnWash },
  noticeWarnText: { color: colors.warnText },
  dismiss: { alignSelf: "flex-start" },
});
