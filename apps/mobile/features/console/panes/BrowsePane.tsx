import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { colors, radii, space } from "../../design/tokens";
import { Breadcrumb } from "../files/Breadcrumb";
import { NoteEditor } from "../files/NoteEditor";
import { ShareDialog } from "../files/ShareDialog";
import { consoleOrigin } from "../files/shareOrigin";
import { findEntry } from "../files/tree";
import type { FileEntry, Visibility } from "../files/types";
import { atName } from "../format";
import { selectedContext, type ConsoleData } from "../types";
import { tierSentence } from "../visibility";

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

  /**
   * The note the share dialog is open for, or `null`.
   *
   * Held here rather than lifted into `Explorer`'s dialog union: that state
   * belongs to the *tree*, and this is the editor region. Two entry points to
   * one dialog is not two dialogs — `ShareDialog` holds nothing of its own
   * beyond a draft recipient.
   */
  const [sharing, setSharing] = useState<string | null>(null);

  const noBucket = data.storage === null && !data.loading;
  const manifestBroken = files.listings[""]?.manifestUsable === false;
  /*
    The one notice here that is not an event.

    Browse is the pane where an absence is invisible: a folder the owner keeps
    private does not appear in the tree, so an editor reading a short list has
    no way to tell a small context from a filtered one. That is the whole
    reason this line exists, and it is why it stays up rather than being
    dismissible — the condition it reports never stops being true. `null` for
    an owner, and `null` while the role is still loading.
  */
  const tierNote = tierSentence(current?.role);
  const hasNotice =
    tierNote !== null ||
    noBucket ||
    manifestBroken ||
    files.notice !== null ||
    (files.readOnlyReason !== undefined && !files.canEdit);

  return (
    <View style={styles.region}>
      {selected !== null && selected.kind === "file" ? (
        <View style={styles.noteHead}>
          <View style={styles.crumb}>
            <Breadcrumb
              path={selected.path}
              contextLabel={contextLabel}
              visibility={selected.visibility}
              inherited={selected.inherited}
              exception={selected.exception}
              readOnly={selected.readOnly}
              onSelectFolder={files.select}
            />
          </View>
          {/*
            Share is here, beside the note, and not only in the row's menu.

            It was menu-only first, and that made it a feature nobody had: on a
            phone the menu is a long-press on a *file row*, so somebody reading
            a note — which is exactly when they decide to send it to a
            colleague — had no row to press and no button to find. `Empty`
            below already states the rule this broke: "a right-click menu
            nobody discovers is a feature nobody has."

            It stays in the menu too. The menu is how you act on a note you are
            not looking at; this is how you act on the one you are.

            Absent rather than disabled for anyone who is not the owner, and
            absent for `privacy.md` and anything else read-only — the same rule
            the menu applies, and the server refuses it regardless with
            `minimum: "owner"`.
          */}
          {files.canShare && !selected.readOnly ? (
            <Button
              label="Share…"
              onPress={() => setSharing(selected.path)}
              testID="browse-share"
            />
          ) : null}
        </View>
      ) : null}

      {sharing !== null ? (
        <ShareDialog
          path={sharing}
          shares={files.shares}
          origin={consoleOrigin()}
          contextSlug={current?.slug}
          onShare={(recipient) => files.share(sharing, recipient)}
          onRevoke={(shareId) => files.revokeShare(shareId)}
          onSetPreviewTitle={(recipient, on) =>
            files.setSharePreviewTitle(sharing, recipient, on)
          }
          onClose={() => setSharing(null)}
        />
      ) : null}

      {hasNotice ? (
        <View style={styles.notices}>
          {tierNote !== null ? (
            <View style={styles.notice} testID="browse-tier-notice">
              {/*
                The sentence without the chip. The chip is in the top bar, on
                every route of this context — repeating it two inches below
                reads as two different claims rather than one. What earns its
                height here is the sentence: a private folder in this tree is
                not dimmed, it is *absent*, so somebody reading a short list
                otherwise cannot tell a small context from a filtered one.
              */}
              <Text variant="hint">{tierNote}</Text>
            </View>
          ) : null}

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
              {/*
                This used to end "Write a valid privacy.md at the root of the
                bucket, or ask a connected AI client to", and **neither was
                possible**. Every write path in the product refuses that key:
                the console's own `writeFile` answers
                PRIVACY_MANIFEST_READ_ONLY, the gateway's `write_note` answers
                "that path is reserved", and `set_folder_visibility` answers
                "privacy.md is required before folder visibility can be
                changed". The only exit was rclone or the provider's web
                console — so the sentence sent people to try two things that
                cannot work, in a state where nothing else works either.

                The button is the exit. It is absent rather than disabled for
                anyone who is not the owner, so the copy has to carry both
                cases: an editor reads the same explanation and is told whose
                fix it is.
              */}
              <Text variant="hint" style={styles.noticeWarnText}>
                privacy.md is missing or could not be read, so everything is treated as private
                and nothing can be shared until it is fixed. Nothing is exposed by this — it
                fails closed.{" "}
                {files.canResetPrivacy
                  ? "Resetting it writes a fresh one declaring the folders this bucket has, every one of them private, and keeps the unreadable file in .history/. Nothing becomes visible to anybody; you choose what to share afterwards."
                  : "Only the owner of this context can rewrite it — ask them to reset it from their console, or fix it in the bucket directly."}
              </Text>
              {files.canResetPrivacy ? (
                <Button
                  label="Reset privacy.md"
                  onPress={files.resetPrivacy}
                  disabled={files.busy}
                  style={styles.dismiss}
                  testID="browse-reset-privacy"
                />
              ) : null}
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
            canSetVisibility={files.canSetVisibility}
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
  canSetVisibility,
  onSetVisibility,
}: {
  entry: FileEntry;
  /**
   * Owner-only, like every visibility control. This pane's button said
   * `canEdit` once, which put "Make this folder private" in front of an
   * editor on somebody else's context — offered, then refused by the
   * server. Absent is the truth.
   */
  canSetVisibility: boolean;
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
      {canSetVisibility ? (
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
  /** The breadcrumb takes the room it needs; Share sits at the end of the line. */
  noteHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
  crumb: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
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
