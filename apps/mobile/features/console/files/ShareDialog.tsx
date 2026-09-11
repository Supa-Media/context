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

import { useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { baseName } from "./paths";
import { accessRows, accessSummary, type AccessMember } from "./access";
import { recipientsFor, type RecipientGroup } from "./recipients";
import type { Visibility } from "./types";
import {
  describeOpenLink,
  describePersonalShare,
  describePreviewTitle,
  describeShareRow,
  describeTeamLink,
  shareUrlFor,
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
  advanced,
  access,
  onShareWithGroup,
  groups,
}: {
  path: string;
  /** Every share on this context, or `undefined` while the query is in flight. */
  shares: readonly NoteShare[] | undefined;
  /** Where this console is served from. See `shareUrl`. */
  origin: string;
  onShare: (recipient: string) => void;
  /**
   * Point this note at a group.
   *
   * A different verb from `onShare`, because it is a different thing: a share
   * hands one note to somebody through a revocable row, and this writes a rule
   * into `privacy.md` that the group's membership then resolves. Absent where
   * the caller cannot do it — the demo, and anybody who is not an owner.
   */
  onShareWithGroup?: (group: string) => void;
  /** The groups this context has, for the field to offer. Owner-only upstream. */
  groups?: readonly RecipientGroup[];
  /**
   * A section drawn under everything else here, behind its own "ADVANCED"
   * label — today, whatever `EncryptionAdvancedSection` in
   * `features/console/encryption/` has to say about this note. This dialog
   * stays agnostic about what it is: sharing decides who may read a note
   * through the gateway, and encryption decides what the bytes are while
   * nobody is asking — `docs/decisions/encryption.md`'s opening argument for
   * why the two never collapse into one control. Absent where the caller has
   * nothing to add, rather than an empty labelled section.
   */
  advanced?: ReactNode;
  /**
   * Put a link on the clipboard. Answers whether it landed.
   *
   * The mint and the write are one call rather than two — see
   * `FileBrowser.copyShareLink`. Doing it here, as "await a URL, then write
   * it", is what made this button do nothing at all on iOS.
   */
  onCopyLink: (
    target:
      | { kind: "team"; path: string }
      | { kind: "link"; path: string }
      | { kind: "share"; url: string },
  ) => Promise<{ ok: boolean; message: string | null }>;
  onRevoke: (shareId: string) => void;
  onSetPreviewTitle: (share: NoteShare, titleInPreview: boolean) => void;
  onClose: () => void;
  /**
   * What the note reads as, and the people this context has.
   *
   * Both arrive already decided — `visibility` off the server's own
   * `effectiveVisibility` at this caller's scope, `members` off `listMembers` —
   * and `access.ts` only joins them. Optional because this dialog is also
   * rendered on the landing page's read-only demo, which has no membership to
   * show and should draw the section it can rather than an empty one.
   */
  access?: {
    visibility: Visibility;
    exception: boolean;
    /** `undefined` while the membership is still loading. Not an empty list. */
    members: readonly AccessMember[] | undefined;
  };
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [recipient, setRecipient] = useState("");
  /**
   * What went wrong with the last copy, or `null`.
   *
   * Carries the URL when the clipboard refused, because the clipboard is the
   * only part that failed and the person still wants the link. `null` when the
   * *link* could not be made: the server has already said why, in the pane,
   * and repeating a symptom over a real refusal is worse than saying nothing.
   */
  const [problem, setProblem] = useState<string | null>(null);

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
    target:
      | { kind: "team"; path: string }
      | { kind: "link"; path: string }
      | { kind: "share"; url: string },
  ) => {
    setProblem(null);
    void onCopyLink(target).then(({ ok, message }) => {
      if (ok) {
        onClose();
        return;
      }
      /*
        **Shown here, not behind here.** The pane's notice line sits under this
        modal, so a failure raised there is a message nobody can read — and on
        a platform where every copy failed, that made Copy link a button that
        did nothing at all. The dialog is the surface the press happened on, so
        it is the surface that answers.
      */
      setProblem(message);
    });
  };

  const mine = sharesFor(shares, path);
  /**
   * The live unlisted link on this note, if there is one.
   *
   * `undefined` covers both "there is none" and "the list has not loaded",
   * which are deliberately the same here: the button reads "Create link" in
   * both, and pressing it on a note that already has one supersedes in place
   * and returns the same token. A third state for "we do not know yet" would
   * be a flicker on every open of a dialog somebody came to press one button
   * in.
   */
  const openLink = mine?.find((share) => share.audience === "anyone");
  const ready = recipient.trim() !== "";

  /*
    Built from what the dialog already has: `access.members` is this context's
    people and `groups` its groups. Anybody already on the note is excluded —
    offering to share with somebody who can read it is offering to do nothing.
  */
  const suggestions = recipientsFor(
    recipient,
    access?.members ?? [],
    groups ?? [],
    {
      excludeUserIds: new Set((access?.members ?? []).map((member) => member.userId)),
      excludeGroups:
        access !== undefined && access.visibility.startsWith("@")
          ? new Set([access.visibility.slice(1)])
          : undefined,
    },
  );

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
              {/*
                The list this section is named after, which it did not have.

                It said "PEOPLE WITH ACCESS" and then offered a link — the one
                thing on the screen that is not a person — so an owner could not
                answer the question the heading asks about the note in front of
                them. The summary line above the names carries the half a list
                cannot show: whether the rule is on this note or inherited from
                the folder, which is the difference between "fine" and "wait,
                that folder?".
              */}
              {access === undefined ? null : (
                <View style={styles.access} testID="share-access">
                  <Text variant="paneSub">
                    {accessSummary(access.visibility, access.exception)}
                  </Text>
                  {accessRows(access.visibility, access.exception, access.members).map((row) => (
                    <View key={row.key} style={styles.accessRow}>
                      <Text variant="rowTitle" style={styles.accessName}>
                        {row.label}
                      </Text>
                      <Text variant="meta" style={styles.accessReason}>
                        {row.reason}
                      </Text>
                      <Text variant="meta">{row.role}</Text>
                    </View>
                  ))}
                </View>
              )}
              <Text variant="paneSub">{describeTeamLink()}</Text>
              {problem === null ? null : (
                <Text variant="meta" testID="share-copy-problem" selectable>
                  {problem}
                </Text>
              )}
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

            {/*
              **The section this dialog was missing, and the bug it caused.**

              The lock's third position mints an unlisted link, and the only
              place it then appeared was a row in SHARED WITH below the fold —
              while the button at the top of this dialog, the one anybody
              presses, mints a *team* link and copies a `/console/@…` URL. So
              "publish this, then copy it" handed people the wrong link: one
              that shows nothing at all to the person they sent it to.

              It is a section of its own rather than a row, because it is a
              different audience from either of its neighbours — not the people
              who already have access, and not one named person — and because
              the press that copies it has to be the press that mints it, for
              the iOS activation reason `copyShareLink` documents.
            */}
            <View style={styles.section}>
              <Text variant="eyebrow">ANYONE WITH THE LINK</Text>
              <Text variant="paneSub">{describeOpenLink(openLink !== undefined)}</Text>
              <View style={styles.row}>
                <Button
                  label={openLink === undefined ? "Create link" : "Copy link"}
                  variant="white"
                  onPress={() => copyAndClose({ kind: "link", path })}
                  testID="share-open-link"
                />
                {openLink === undefined ? null : (
                  <Button
                    label="Revoke"
                    variant="danger"
                    onPress={() => onRevoke(openLink.shareId)}
                    testID="share-open-link-revoke"
                  />
                )}
              </View>
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
                placeholder="Name, group or email"
                placeholderTextColor={colors.muted}
                accessibilityLabel="Share with"
                onSubmitEditing={submit}
              />
              <Button label="Share" variant="white" disabled={!ready} onPress={submit} />
            </View>

            {/*
              One field, one list.

              A person and a group are the same kind of token in `privacy.md` —
              `@kola` and `@supa-leads` are indistinguishable to the parser —
              so this does not ask which KIND you mean before letting you type.
              What it does keep separate is the invite row: choosing it is two
              things, an invitation and then the access, and the row says so
              before it happens rather than after.

              Picking a group writes the rule; picking a person or an address
              mints the share row that already existed. Different verbs, one
              field, because the difference is ours and not theirs.
            */}
            {suggestions.length === 0 ? null : (
              <View style={styles.suggestions} testID="share-suggestions">
                {suggestions.map((row) => (
                  <Pressable
                    key={`${row.kind}:${row.key}`}
                    style={styles.suggestion}
                    accessibilityLabel={`Share with ${row.label}`}
                    testID={`share-suggest-${row.key}`}
                    onPress={() => {
                      setRecipient("");
                      if (row.kind === "group" && onShareWithGroup !== undefined) {
                        onShareWithGroup(row.group!);
                        return;
                      }
                      onShare(row.kind === "member" ? row.label : row.key);
                    }}
                  >
                    <Text variant="rowTitle">{row.label}</Text>
                    {row.detail === undefined ? null : (
                      <Text variant="meta" style={styles.suggestionDetail}>
                        {row.detail}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            <SharedWith
              shares={mine}
              origin={origin}
              onCopyLink={copyAndClose}
              onRevoke={onRevoke}
              onSetPreviewTitle={onSetPreviewTitle}
            />

            {advanced !== undefined ? (
              <View style={styles.section}>
                <Text variant="eyebrow">ADVANCED</Text>
                {advanced}
              </View>
            ) : null}
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
  onSetPreviewTitle: (share: NoteShare, titleInPreview: boolean) => void;
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
                  onCopyLink({ kind: "share", url: shareUrlFor(share, origin) })
                }
              />
              <Button
                label="Revoke"
                variant="danger"
                onPress={() => onRevoke(share.shareId)}
              />
            </View>

            {/*
              What this row actually grants, under its name. The list holds
              three things that look alike and one of them needs no account at
              all — "Copy link / Revoke" beside each says nothing about which.
            */}
            <Text variant="meta" style={styles.previewText}>
              {describeShareRow(share.audience)}
            </Text>

            <View style={styles.previewRow}>
              <Text variant="meta" style={styles.previewText}>
                {share.titleInPreview
                  ? describePreviewTitle(share.previewTitle, share.audience)
                  : "The link shows nothing about this note before signing in."}
              </Text>
              <Button
                label={share.titleInPreview ? "Hide name" : "Show name"}
                onPress={() =>
                  onSetPreviewTitle(share, !share.titleInPreview)
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
  access: { gap: 8, marginBottom: 4 },
  accessRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
    paddingVertical: 4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  accessName: { flexShrink: 0 },
  accessReason: { flexGrow: 1, flexShrink: 1, minWidth: 0, color: colors.muted },
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
  suggestions: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    overflow: "hidden",
  },
  suggestion: { paddingVertical: 8, paddingHorizontal: 10, gap: 2 },
  suggestionDetail: { color: colors.muted },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  previewText: { flexGrow: 1, flexShrink: 1 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
});
