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
import { writeClipboard } from "../../design/clipboard";
import { colors, fonts, radii } from "../../design/tokens";
import { baseName } from "./paths";
import {
  describePersonalShare,
  describePreviewTitle,
  describeShare,
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
  onTeamLink,
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
  /** Mint-or-reuse the team link and hand back its URL, or `null` on failure. */
  onTeamLink: () => Promise<string | null>;
  onRevoke: (shareId: string) => void;
  onSetPreviewTitle: (recipient: string, titleInPreview: boolean) => void;
  onClose: () => void;
}) {
  const [recipient, setRecipient] = useState("");
  /** Which link was last copied: a share's id, or `TEAM_LINK`. */
  const [copied, setCopied] = useState<string | null>(null);

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
                label={copied === TEAM_LINK ? "Copied" : "Copy link"}
                variant="white"
                onPress={() => {
                  /*
                    Minted on demand rather than up front: a token per note for
                    every note anybody opened would fill the share list with
                    links nobody asked for. Pressing this is the ask.

                    `/s/<token>` and not `/console/@slug?note=…`, and the two
                    are not interchangeable. Both open the same note for the
                    same people, but only the token is unguessable — which is
                    what lets its card carry the note's title. A console URL is
                    typeable by anyone who knows the handle, so a titled card
                    there would answer "does this note exist?" to whoever asked.
                  */
                  void onTeamLink().then((url) => {
                    if (url === null) {
                      setCopied(null);
                      return;
                    }
                    void writeClipboard(url).then((ok) =>
                      setCopied(ok ? TEAM_LINK : null),
                    );
                  });
                }}
              />
            </View>

            <View style={styles.section}>
              <Text variant="eyebrow">SOMEBODY WITHOUT ACCESS</Text>
              <Text variant="paneSub">{describePersonalShare()}</Text>
              <Text variant="meta">{describeShare()}</Text>
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
              copied={copied}
              onCopied={setCopied}
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
  copied,
  onCopied,
  onRevoke,
  onSetPreviewTitle,
}: {
  shares: NoteShare[] | undefined;
  origin: string;
  copied: string | null;
  onCopied: (shareId: string | null) => void;
  onRevoke: (shareId: string) => void;
  onSetPreviewTitle: (recipient: string, titleInPreview: boolean) => void;
}) {
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
                label={copied === share.shareId ? "Copied" : "Copy link"}
                onPress={() => {
                  void writeClipboard(shareUrl(share.token, origin)).then((ok) => {
                    // Only claim it on success. Native has no clipboard here and
                    // says so by returning false; a label that reads "Copied"
                    // over a no-op is the kind of small lie nobody forgives.
                    onCopied(ok ? share.shareId : null);
                  });
                }}
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

/** Sentinel for "the team link", which has no share id of its own. */
const TEAM_LINK = "team-link";

const styles = StyleSheet.create({
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
