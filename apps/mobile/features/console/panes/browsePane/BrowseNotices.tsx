import { View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Text } from "../../../design/components/Text";
import { useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../../files/browser";
import {
  STORAGE_MIGRATION_OFFER,
  StorageMigrationActions,
} from "../../storage/StorageMigration";
import type { ConsoleData, selectedContext } from "../../types";
import { setupPromptVisible } from "../../setup";
import { SetupPrompt } from "../../setup/SetupPrompt";
import type { BrowsePaneProps } from "./props";
import { makeStyles } from "./styles";
import type { BrowseNoticeState } from "./useBrowseNotices";

/**
 * The band itself, drawn from `useBrowseNotices`. Where it sits — above the
 * region on a pointer, inside the document on a phone — is `BrowsePane`'s.
 */
export function BrowseNotices({
  data,
  files,
  current,
  compact,
  onOpenSettings,
  setup,
  introVisible,
  intro,
  introAnswer,
  noBucket,
  manifestBroken,
  moveNotices,
  setDismissedMoves,
  storageMigration,
}: {
  data: ConsoleData;
  files: FileBrowser;
  current: ReturnType<typeof selectedContext>;
  compact: boolean;
  onOpenSettings: BrowsePaneProps["onOpenSettings"];
  setup: BrowseNoticeState["setup"];
  introVisible: boolean;
  intro: BrowseNoticeState["intro"];
  introAnswer: BrowseNoticeState["introAnswer"];
  noBucket: boolean;
  manifestBroken: boolean;
  moveNotices: BrowseNoticeState["moveNotices"];
  setDismissedMoves: BrowseNoticeState["setDismissedMoves"];
  storageMigration: BrowseNoticeState["storageMigration"];
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.notices, compact && styles.noticesCompact]}>
      {/*
        First in the band, and above the privacy warning it is the answer to.

        On an empty context both are drawn: there is no `privacy.md` in a bucket
        nothing has ever been written to, so the manifest notice below is
        correct, alarming, and — for this one state — something the owner can do
        nothing about directly. Writing a layout writes the manifest with it, so
        the card above the warning is the fix above the symptom. Ordered rather
        than conditional: the warning is still true until the scaffold lands,
        and hiding a fails-closed privacy notice because a fix is on offer is
        the wrong way round.
      */}
      {setupPromptVisible(setup) && current?.id !== undefined ? (
        <SetupPrompt
          setup={setup}
          workspaceId={current.id}
          /*
            The importer is Settings → Storage's and is not rebuilt here. A
            lambda with the section it means, for `browse-connect-storage`'s
            reason: a press handler is called with a gesture event, and passing
            `onOpenSettings` bare sends the route `?settings=[object Object]`.
          */
          onImportVault={onOpenSettings === undefined ? undefined : () => onOpenSettings("storage")}
        />
      ) : null}

      {introVisible ? (
        <View style={styles.notice} testID="browse-context-intro">
          {/*
            The sentence without the chip. The chip is in the top bar, on
            every route of this context — repeating it two inches below
            reads as two different claims rather than one. What earns its
            height here is the sentence: a private folder in this tree is
            not dimmed, it is *absent*, so somebody reading a short list
            otherwise cannot tell a small context from a filtered one.
          */}
          <Text variant="hint">{intro!.text}</Text>
          {data.demo === true || compact ? null : (
            <Button
              /*
                "Got it", not "Dismiss". Every other control in this band puts
                aside a thing that needs somebody — a failed move, a warning, an
                offer to run something. This one is read, and the word should
                say that the reader is finished with it rather than that a
                problem has been deferred. The fact itself does not go anywhere:
                it is on the chip above, on every route of this context.
              */
              label="Got it"
              onPress={introAnswer.dismiss}
              style={styles.dismiss}
              testID="browse-context-intro-dismiss"
            />
          )}
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
              /*
                Called in a lambda, and with the section it means.

                `onPress={onOpenSettings}` read as a tidy pass-through and was
                a dead button: React Native hands a press handler its
                `GestureResponderEvent`, `onOpenSettings` takes an optional
                *section key*, so the event arrived as the section and the
                route was asked for `?settings=[object Object]` — which
                resolves to nothing. `browseNoticeActions.test.ts` presses it
                and asserts what it was called with.

                `storage` rather than nothing: the button says "Connect a
                bucket", and opening settings at Overview to go hunting for
                the Storage section is the same defect one screen further on.
              */
              onPress={() => onOpenSettings("storage")}
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

      {moveNotices.map((move) => (
        <View
          key={move.id}
          style={[styles.notice, move.tone === "warn" && styles.noticeWarn]}
          testID={`browse-context-move-${move.id}`}
        >
          <Text
            variant="hint"
            style={move.tone === "warn" ? styles.noticeWarnText : undefined}
          >
            {move.text}
          </Text>
          {move.resumable ? (
            <Button
              label="Finish the move"
              onPress={() => files.resumeContextMove(move.id)}
              disabled={files.busy}
              style={styles.dismiss}
              testID={`browse-context-move-resume-${move.id}`}
            />
          ) : null}
          {move.dismissible ? (
            <Button
              /*
                "Not now" on a failure, because that is what the press does.
                `dismissContextMove` takes a completed move only — a failed
                one's notice carries the single control that can finish it
                (see that mutation on why a fresh move cannot), so putting it
                aside is for the session and it comes back. The other notice
                in this band that can be taken up later says "Not now" for the
                same reason; a "Dismiss" that undismisses itself overnight is
                the complaint this whole change came from.
              */
              label={move.resumable ? "Not now" : "Dismiss"}
              /*
                Both halves, and neither is the other's fallback. The server
                is where a durable answer lives — the row is listable for a
                day and reaches every device this person signs in on — but the
                query behind `files.contextMoves` does not turn around inside
                the press, and a notice that sits there for a beat after being
                dismissed is a button that looks broken. So the local set
                hides it now and the mutation, where it applies, keeps it
                hidden. Called unconditionally: which statuses are answerable
                is the server's rule, and a second copy of it here is a second
                thing to keep in step.
              */
              onPress={() => {
                setDismissedMoves((current) => new Set([...current, move.id]));
                files.dismissContextMove(move.id);
              }}
              style={styles.dismiss}
              testID={`browse-context-move-dismiss-${move.id}`}
            />
          ) : null}
        </View>
      ))}

      {files.notice !== null ? (
        <View style={[styles.notice, styles.noticeWarn]}>
          <Text variant="hint" style={styles.noticeWarnText}>
            {files.notice}
          </Text>
          {/*
            Also in a lambda, for the reason the button above gives: this one
            takes no arguments so the press event was harmless, and the next
            person to give it a parameter would inherit a silent bug rather
            than a failing test.
          */}
          <Button
            label="Dismiss"
            onPress={() => files.dismissNotice()}
            style={styles.dismiss}
            testID="browse-dismiss-notice"
          />
        </View>
      ) : null}

      {/*
        Last, and the only line here that is an *offer* rather than a report.

        No wash: the warn colours in this band mean "something is wrong and it
        is yours to fix", and nothing is wrong. It is the hint treatment the
        tier line uses, with two buttons — one to run it, one to stop being
        asked — and the dialog behind the first is the same one both entry
        points raise.
      */}
      {storageMigration.visible && files.updateStorageLayout !== undefined ? (
        <View style={styles.notice} testID="browse-storage-migration">
          <Text variant="hint">{STORAGE_MIGRATION_OFFER}</Text>
          <StorageMigrationActions
            run={files.updateStorageLayout}
            onDismiss={storageMigration.dismiss}
            style={styles.noticeActions}
          />
        </View>
      ) : null}
    </View>
  );
}
