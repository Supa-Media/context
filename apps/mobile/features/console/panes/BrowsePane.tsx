import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { colors, radii, space } from "../../design/tokens";
import { Breadcrumb } from "../files/Breadcrumb";
import type { FileBrowser } from "../files/browser";
import { NoteEditor } from "../files/NoteEditor";
import { findEntry } from "../files/tree";
import type { FileEntry, Visibility } from "../files/types";
import { atName } from "../format";
import { selectedContext, type ConsoleData } from "../types";

/**
 * Browse — the note, and nothing between you and it.
 *
 * The tab strip is *not* here. It is chrome belonging to the editor region, so
 * the layout draws it above this pane — which also keeps one tab state in the
 * app rather than one per pane that mounts.
 *
 * ## What this pane used to be
 *
 * The whole file editor: a 246px tree beside the note, a "New note / New
 * folder" toolbar above the tree, a pane heading with a paragraph explaining
 * what markdown is, and — above every document — a card header carrying the
 * file name, two chips and a byte count, and beneath *that* a row of seven
 * buttons: Rename, Move, Duplicate, Copy, Cut, Archive, Delete…
 *
 * All of it is gone, and every operation still exists. The tree became a region
 * of the frame (`files/Explorer.tsx`); the buttons became the row's own
 * right-click menu and long-press sheet; the card header became a one-line
 * breadcrumb at the top of the region. What is left is a tab strip, a
 * breadcrumb, and the document — which is what the editor was always for.
 *
 * ## Why the note is no longer in a card
 *
 * A bordered, rounded, inset card is right for a *widget on a page* and wrong
 * for the primary surface of an application. It cost 16px of padding, a border
 * and a radius on all four sides of the thing people actually came to read, and
 * it drew a boundary around the one element that should extend to the edges of
 * its region. The editor now fills what it is given.
 */
export function BrowsePane({
  data,
  /**
   * Opens this context's settings. Absent where there is nowhere to go, and the
   * control is then not rendered rather than rendered dead.
   */
  onOpenSettings,
}: {
  data: ConsoleData;
  onOpenSettings?: () => void;
}) {
  const files = data.files;
  const current = selectedContext(data);
  const contextLabel = atName(current?.slug ?? "your context");

  const selected =
    files.selectedPath === null ? null : findEntry(files.listings, files.selectedPath);

  const noBucket = data.storage === null && !data.loading;
  const manifestBroken = files.listings[""]?.manifestUsable === false;
  const hasNotice =
    noBucket ||
    manifestBroken ||
    files.notice !== null ||
    (files.readOnlyReason !== undefined && !files.canEdit);

  return (
    <View style={styles.region}>
      {selected !== null && selected.kind === "file" ? (
        <Breadcrumb
          path={selected.path}
          contextLabel={contextLabel}
          visibility={selected.visibility}
          inherited={selected.inherited}
          exception={selected.exception}
          readOnly={selected.readOnly}
          onSelectFolder={files.select}
        />
      ) : null}

      {hasNotice ? (
        <View style={styles.notices}>
          {files.readOnlyReason !== undefined && !files.canEdit ? (
            <View style={styles.notice}>
              <Text variant="hint">{files.readOnlyReason}</Text>
            </View>
          ) : null}

          {noBucket ? (
            <View style={[styles.notice, styles.noticeWarn]}>
              <Text variant="hint" style={styles.noticeWarnText}>
                No bucket is connected to this context yet, so there is nowhere to keep notes.
                Point it at an S3-compatible bucket you own and everything here starts working
                — your name and your capture address are already yours.
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
                privacy.md is missing or could not be read, so everything is treated as private
                and nothing can be shared until it is fixed. Nothing is exposed by this — it
                fails closed. Write a valid privacy.md at the root of the bucket, or ask a
                connected AI client to, and sharing works again.
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
        </View>
      ) : null}

      <View style={styles.body}>
        {selected === null ? (
          <Empty contextLabel={contextLabel} />
        ) : selected.kind === "folder" ? (
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
      </View>
    </View>
  );
}

/**
 * Nothing open.
 *
 * Says how to open something rather than just that nothing is — and names the
 * gesture that is new, because a right-click menu nobody discovers is a feature
 * that does not exist.
 */
function Empty({ contextLabel }: { contextLabel: string }) {
  return (
    <View style={styles.empty}>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        {contextLabel}
      </Text>
      <Text variant="paneSub" style={styles.emptyLine}>
        Choose a note to read or edit it. Right-click any row — or press and hold on a phone —
        for everything you can do to it.
      </Text>
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
      <Text variant="noteTitle" role="heading" aria-level={2}>
        {entry.path}
      </Text>
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
          style={styles.folderAction}
          onPress={() => onSetVisibility(current === "team" ? "private" : "team")}
        />
      ) : null}
      <Text variant="treeMeta">
        team means named people you granted access to. There is no public tier.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  /** The editor region: chrome on its top edge, the document filling the rest. */
  region: { flex: 1, minHeight: 0 },
  body: { flex: 1, minHeight: 0, padding: space.x4 },

  notices: { paddingHorizontal: space.x4, paddingTop: space.x3, gap: space.x2 },
  notice: {
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

  empty: { padding: space.x6, gap: space.x2, maxWidth: 520 },
  emptyLine: { marginTop: 2 },

  folder: { gap: 14, maxWidth: 620 },
  folderAction: { alignSelf: "flex-start" },
});
