/**
 * Share a note with somebody who is not in this context.
 *
 * ## What this screen has to get across, and why it is wordier than a Share
 * sheet usually is
 *
 * A share is not "anyone with the link". It is a named person, who signs in,
 * and who can then read **this note and the notes it links to** — depth one,
 * decided in `functions/shares.ts`. Every part of that is something the owner
 * would guess wrong if the dialog just said "Share":
 *
 *  - They would expect a link anybody could open, and be surprised their
 *    colleague was asked to sign in.
 *  - They would *not* expect the linked notes to come with it, which is the
 *    part that can hand over more than they meant.
 *  - They would not know the note's name travels to the unfurl before anybody
 *    signs in.
 *
 * So each of the three is stated in a sentence, next to the control it belongs
 * to, in the words it costs. `describeShare` and `describePreviewTitle` live in
 * `shares.ts` so the wording is testable and cannot drift from what the server
 * actually does.
 *
 * ## Nothing here decides authorization
 *
 * Whether this dialog can be reached at all is `canShare` in `capabilities.ts`
 * (owner-only), and the server refuses anyone else with `minimum: "owner"`. The
 * validation below — a recipient that is not blank — is about not sending a
 * request that is certain to fail, never about permission.
 */

import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { baseName } from "./paths";
import {
  describePersonalShare,
  describePreviewTitle,
  describeTeamLink,
  shareUrl,
  sharesFor,
  type NoteShare,
} from "./shares";

export function ShareDialog({
  path,
  shares,
  origin,
  onShare,
  onCopyLink,
  onRevoke,
  onSetPreviewTitle,
  onClose,
}: {
  path: string;
  /** Every share on this context, or `undefined` while the query is in flight. */
  shares: readonly NoteShare[] | undefined;
  /** Where this console is served from. See `shareUrl`. */
  origin: string;
  onShare: (recipient: string) => void;
  /**
   * Put a link on the clipboard. Answers whether it landed.
   *
   * The mint and the write are one call rather than two — see
   * `FileBrowser.copyShareLink`. Doing it here, as "await a URL, then write
   * it", is what made this button do nothing at all on iOS.
   */
  onCopyLink: (
    target: { kind: "team"; path: string } | { kind: "share"; url: string },
  ) => Promise<boolean>;
  onRevoke: (shareId: string) => void;
  onSetPreviewTitle: (recipient: string, titleInPreview: boolean) => void;
  onClose: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [recipient, setRecipient] = useState("");

  /**
   * Copy, and get out of the way.
   *
   * The dialog used to relabel its button "Copied" and stay open, which is two
   * problems: the confirmation is inside a modal the person is now finished
   * with, and it disappears with the dialog they then close. A copy is
   * *invisible* — nothing on screen changes — so it has to be confirmed
   * somewhere that outlives the moment, and the pane's notice line is where
   * this console already says what just happened.
   *
   * Only on success. A failed copy keeps the dialog open, because the notice
   * it raises carries the URL and closing the one surface that could show it
   * again would be the unhelpful half of honesty. That path is a real refusal
   * now rather than a whole platform: native copies for real (`expo-clipboard`
   * is in the baseline), so a `false` here means a browser said no.
   */
  const copyAndClose = (
    target: { kind: "team"; path: string } | { kind: "share"; url: string },
  ) => {
    void onCopyLink(target).then((ok) => {
      if (ok) onClose();
    });
  };

  const mine = sharesFor(shares, path);
  const ready = recipient.trim() !== "";

  const submit = () => {
    if (!ready) return;
    onShare(recipient.trim());
    setRecipient("");
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable
          style={styles.card}
          onPress={() => {}}
          accessibilityLabel={`Share ${baseName(path)}`}
        >
          <Text variant="paneTitle" role="heading" aria-level={2}>
            Share “{baseName(path)}”
          </Text>

          <View style={styles.body}>
            {/*
              The team link comes first because it is the common case and the
              one that needs no setup: most people an owner wants to send a note
              to are people they have already given access to, and for them a
              share would be redundant machinery around a grant they have.
            */}
            <View style={styles.section}>
              <Text variant="eyebrow">PEOPLE WITH ACCESS</Text>
              <Text variant="paneSub">{describeTeamLink()}</Text>
              <Button
                label="Copy link"
                variant="white"
                onPress={() => {
                  /*
                    Minted on demand rather than up front: a token per note for
                    every note anybody opened would fill the share list with
                    links nobody asked for. Pressing this is the ask — and the
                    minting happens *inside* the copy rather than before it,
                    which is what keeps the clipboard reachable on iOS.
                  */
                  copyAndClose({ kind: "team", path });
                }}
              />
            </View>

            <View style={styles.section}>
              <Text variant="eyebrow">SOMEBODY WITHOUT ACCESS</Text>
              {/*
                One sentence, not two. `describeShare` said "they sign in to
                read it, and can open this note and the notes it links to —
                nothing else in your context", directly under a line that had
                just said "they get this note and the notes it links to —
                nothing else". Two paragraphs making the same point read as two
                points, and the screen was long enough that the controls were
                below the fold on a phone.
              */}
              <Text variant="paneSub">{describePersonalShare()}</Text>
            </View>

            <View style={styles.row}>
              <TextInput
                value={recipient}
                onChangeText={setRecipient}
                autoFocus
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                placeholder="@name or email"
                placeholderTextColor={colors.muted}
                accessibilityLabel="Share with"
                onSubmitEditing={submit}
              />
              <Button label="Share" variant="white" disabled={!ready} onPress={submit} />
            </View>

            <SharedWith
              shares={mine}
              origin={origin}
              onCopyLink={copyAndClose}
              onRevoke={onRevoke}
              onSetPreviewTitle={onSetPreviewTitle}
            />
          </View>

          <View style={styles.actions}>
            <Button label="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Who currently has this note.
 *
 * Three states, and the first two are deliberately not the same sentence.
 * `undefined` is "we have not been told yet"; an empty array is "nobody". A
 * dialog that renders loading as "Not shared with anyone" tells the owner their
 * share failed, and the recoverable mistake they make next is sharing it twice.
 */
function SharedWith({
  shares,
  origin,
  onCopyLink,
  onRevoke,
  onSetPreviewTitle,
}: {
  shares: NoteShare[] | undefined;
  origin: string;
  onCopyLink: (target: { kind: "share"; url: string }) => void;
  onRevoke: (shareId: string) => void;
  onSetPreviewTitle: (recipient: string, titleInPreview: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  if (shares === undefined) {
    return <Text variant="meta">Loading who has access…</Text>;
  }
  if (shares.length === 0) {
    return (
      <Text variant="meta">
        Not shared with anyone yet. Nobody outside this context can open it.
      </Text>
    );
  }

  return (
    <View style={styles.list}>
      <Text variant="meta" style={styles.listHead}>
        SHARED WITH
      </Text>
      <ScrollView style={styles.listScroll}>
        {shares.map((share) => (
          <View key={share.shareId} style={styles.share}>
            <View style={styles.shareTop}>
              <Text variant="body" style={styles.recipient} numberOfLines={1}>
                {share.recipient}
              </Text>
              <Button
                label="Copy link"
                onPress={() =>
                  onCopyLink({ kind: "share", url: shareUrl(share.token, origin) })
                }
              />
              <Button
                label="Revoke"
                variant="danger"
                onPress={() => onRevoke(share.shareId)}
              />
            </View>

            <View style={styles.previewRow}>
              <Text variant="meta" style={styles.previewText}>
                {share.titleInPreview
                  ? describePreviewTitle(share.previewTitle)
                  : "The link shows nothing about this note before signing in."}
              </Text>
              <Button
                label={share.titleInPreview ? "Hide name" : "Show name"}
                onPress={() =>
                  onSetPreviewTitle(share.recipient, !share.titleInPreview)
                }
              />
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}


const makeStyles = (colors: Colors) => StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 560,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: 20,
    gap: 14,
  },
  body: { gap: 16 },
  section: { gap: 8 },
  row: { flexDirection: "row", gap: 10, alignItems: "center" },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 13,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  list: { gap: 8 },
  listHead: { letterSpacing: 1, color: colors.muted },
  // Capped so a note shared with a dozen people does not push Done off screen.
  listScroll: { maxHeight: 260 },
  share: {
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    marginBottom: 8,
  },
  shareTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  recipient: { flexGrow: 1, flexShrink: 1, color: colors.text },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  previewText: { flexGrow: 1, flexShrink: 1 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
});
