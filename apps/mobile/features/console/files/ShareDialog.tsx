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
import {
  accessRows,
  accessSummary,
  type AccessMember,
  type AccessRow,
  type RemovalRoute,
} from "./access";
import { noMatchHint, recipientsFor, type RecipientGroup } from "./recipients";
import { canMakeGroup, memberLabel, previewGroupName } from "../groups/groups";
import { isGroupVisibility, type Visibility } from "./types";
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
  onRemovalRoute,
  onCreateGroup,
  groupSlug,
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
   * Take somebody's access away, by the route they picked.
   *
   * Routes rather than a `remove(userId)`, because **one person cannot be
   * peeled off a team-visible note** — `team` means every member, and
   * `privacy.md` has no per-person exception. `access.ts` carries the full
   * argument; the short version is that the two real answers are "narrow this
   * note" and "remove them from the context", they differ by an entire
   * context, and a single Remove button would have to silently pick one.
   *
   * Absent where the caller cannot do it — the demo, and anybody who is not an
   * owner — and then no row draws a control at all, which is this console's
   * standing rule for a control somebody may not use.
   */
  onRemovalRoute?: (route: RemovalRoute, row: AccessRow) => void;
  /**
   * Make a group out of people picked here, and point this note at it.
   *
   * `GroupsPanel` opens by admitting "Nobody should have to come here first",
   * and until now it was the only door: sharing one note with three people
   * meant leaving the note, opening Settings, typing a label, adding three
   * members one at a time, coming back and typing the group's name. The moment
   * a group should exist is this one.
   *
   * Absent for anybody who is not an owner and in the demo, like every other
   * group control — `createGroup` and `addGroupMember` are owner-only.
   */
  onCreateGroup?: (label: string, userIds: readonly string[]) => void;
  /** The workspace's own slug, for showing the name a label will become. */
  groupSlug?: string;
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
   * The row whose removal routes are open, by `AccessRow.key`, or `null`.
   *
   * Expanded in place rather than in a second `Modal`. A modal over a modal is
   * a known iOS problem, and the thing being confirmed is *which* route — a
   * question about a row, next to the row, where the reason line that explains
   * why they reach the note at all is still on screen to read.
   */
  const [removing, setRemoving] = useState<string | null>(null);
  /**
   * The group being made here, or `null` when nothing is.
   *
   * `label` seeds from whatever was typed into the share field, because that is
   * usually the word somebody wants — they typed "leads", found no group, and
   * are now making one.
   */
  const [making, setMaking] = useState<{ label: string; picked: string[] } | null>(null);

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
    Who this note reaches, computed ONCE and read by both the list below and
    the suggestions above it.

    That sharing is the fix rather than a tidy-up. The suggestions used to take
    their own exclusion set — every member of the workspace — while the list
    took `accessRows`, so the two disagreed about who had the note and the
    disagreement was invisible: on a team-visible note the list showed four
    people and the field, having excluded all four, showed nothing at all for
    any name you typed. One source, one answer.
  */
  const rows =
    access === undefined
      ? []
      : accessRows(access.visibility, access.exception, access.members);
  const reachingUserIds = new Set(
    rows.filter((row) => row.role !== "group").map((row) => row.key),
  );
  const reachingGroups =
    access !== undefined && isGroupVisibility(access.visibility)
      ? new Set([access.visibility.slice(1)])
      : undefined;

  const suggestions = recipientsFor(recipient, access?.members ?? [], groups ?? [], {
    reachingUserIds,
    reachingGroups,
  });
  // Only when something was typed and nothing came back. See `noMatchHint`.
  const emptyHint = suggestions.length === 0 ? noMatchHint(recipient) : undefined;

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

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            {/*
              The field first, and the reason is the whole shape of this
              screen.

              It used to be fourth, under three eyebrow sections that each
              opened with a paragraph — so on a phone the thing you came here
              to do was below the fold, and `autoFocus` then raised the
              keyboard over what was left. A share dialog is a place you type a
              name; everything else on it is context for that, and context goes
              after.

              No `autoFocus` for the same reason: the sheet has to be readable
              before it is typed into.
            */}
            <View style={styles.row}>
              <TextInput
                value={recipient}
                onChangeText={setRecipient}
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
            {/*
              Where a group is born.

              Offered under the field rather than inside the suggestion list:
              the list answers "who do you mean", and this is a different verb
              that should not move around as rows come and go. Absent entirely
              for a non-owner, which is this console's rule for a control the
              server would refuse.
            */}
            {onCreateGroup === undefined || groupSlug === undefined ? null : making === null ? (
              <Pressable
                style={styles.makeGroup}
                accessibilityLabel="Make a group from people here"
                testID="share-make-group"
                onPress={() => setMaking({ label: recipient.trim(), picked: [] })}
              >
                <Text variant="rowTitle">New group…</Text>
                <Text variant="meta" style={styles.suggestionDetail}>
                  Name the people you keep picking together, then point notes at the name.
                </Text>
              </Pressable>
            ) : (
              <GroupMaker
                slug={groupSlug}
                members={access?.members ?? []}
                state={making}
                onChange={setMaking}
                onCancel={() => setMaking(null)}
                onCreate={() => {
                  onCreateGroup(making.label.trim(), making.picked);
                  setMaking(null);
                  setRecipient("");
                }}
              />
            )}

            {emptyHint === undefined ? null : (
              <Text variant="meta" style={styles.suggestionDetail} testID="share-no-match">
                {emptyHint}
              </Text>
            )}

            {suggestions.length === 0 ? null : (
              <View style={styles.suggestions} testID="share-suggestions">
                {suggestions.map((row) =>
                  /*
                    An answer, not an offer. A row for somebody who already
                    reaches the note is drawn as a statement with no press
                    behind it — pressing it would mint a share that grants
                    nothing, and a control that does nothing is the defect this
                    console keeps recording against itself. It is still SHOWN,
                    which is the whole point: "no rows" could not tell
                    "they already have it" from "no such person".
                  */
                  row.reaches === true ? (
                    <View
                      key={`${row.kind}:${row.key}`}
                      style={[styles.suggestion, styles.suggestionReaching]}
                      testID={`share-reaching-${row.key}`}
                    >
                      <Text variant="rowTitle" style={styles.suggestionMuted}>
                        {row.label}
                      </Text>
                      {row.detail === undefined ? null : (
                        <Text variant="meta" style={styles.suggestionDetail}>
                          {row.detail}
                        </Text>
                      )}
                    </View>
                  ) : (
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
                  ),
                )}
              </View>
            )}

            {/*
              The list this section is named after, which it did not have. It
              said "PEOPLE WITH ACCESS" and then offered a link — the one thing
              on the screen that is not a person.

              The summary line carries the half a list cannot show: whether the
              rule is on this note or inherited from the folder, which is the
              difference between "this is fine" and "wait, that folder?".
            */}
            <View style={styles.section}>
              <Text variant="eyebrow">PEOPLE WITH ACCESS</Text>
              {access === undefined ? null : (
                <View style={styles.access} testID="share-access">
                  <Text variant="paneSub">
                    {accessSummary(access.visibility, access.exception)}
                  </Text>
                  {rows.map((row) => {
                    /*
                      A verb only where one is real. An owner has no removal
                      route — the server refuses both mutations outright — and
                      a caller with no handler is a non-owner or the demo. Both
                      draw the plain role, which is what this list always was.
                    */
                    const canRemove =
                      row.removal.length > 0 && onRemovalRoute !== undefined;
                    const open = removing === row.key;

                    return (
                      <View key={row.key} style={styles.accessGroup}>
                        <View style={styles.accessRow}>
                          <View style={styles.accessMain}>
                            <Text variant="rowTitle">{row.label}</Text>
                            <Text variant="meta" style={styles.accessReason}>
                              {row.reason}
                            </Text>
                          </View>
                          {canRemove ? (
                            <Button
                              label={open ? "Cancel" : "Remove…"}
                              variant="white"
                              onPress={() => setRemoving(open ? null : row.key)}
                              testID={`share-access-remove-${row.key}`}
                            />
                          ) : (
                            <Text variant="meta">{row.role}</Text>
                          )}
                        </View>

                        {!open || !canRemove ? null : (
                          <View style={styles.routes} testID={`share-routes-${row.key}`}>
                            {/*
                              Each route states how far it reaches, because the
                              two differ by an entire context and the label
                              alone cannot carry that. `access.ts` orders them
                              narrowest first, so the safe one is the one under
                              the thumb.
                            */}
                            {row.removal.map((route) => (
                              <Pressable
                                key={route.id}
                                style={styles.route}
                                accessibilityLabel={route.label}
                                testID={`share-route-${route.id}`}
                                onPress={() => {
                                  setRemoving(null);
                                  onRemovalRoute(route, row);
                                }}
                              >
                                <Text
                                  variant="rowTitle"
                                  style={route.danger ? styles.routeDanger : undefined}
                                >
                                  {route.label}
                                </Text>
                                <Text variant="meta" style={styles.accessReason}>
                                  {route.detail}
                                </Text>
                              </Pressable>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}

              <SharedWith
                shares={mine}
                origin={origin}
                onCopyLink={copyAndClose}
                onRevoke={onRevoke}
                onSetPreviewTitle={onSetPreviewTitle}
              />
            </View>

            {/*
              One section for the two links, not two sections with a paragraph
              each.

              They are different audiences and that difference still has to be
              said — a `/console/@…` link shows nothing to somebody without
              access, which is the bug the second one was added for — but it is
              one line beside each button rather than a block above it. Three
              eyebrow headings for three kinds of link was the dialog reading
              as a policy document.
            */}
            <View style={styles.section}>
              <Text variant="eyebrow">GENERAL ACCESS</Text>
              {problem === null ? null : (
                <Text variant="meta" testID="share-copy-problem" selectable>
                  {problem}
                </Text>
              )}

              <View style={styles.linkRow}>
                <View style={styles.linkMain}>
                  <Text variant="rowTitle">People with access</Text>
                  <Text variant="meta" style={styles.linkNote}>
                    {describeTeamLink()}
                  </Text>
                </View>
                <Button
                  label="Copy link"
                  variant="white"
                  onPress={() => {
                    /*
                      Minted on demand rather than up front, and the minting
                      happens *inside* the copy rather than before it — which
                      is what keeps the clipboard reachable on iOS.
                    */
                    copyAndClose({ kind: "team", path });
                  }}
                />
              </View>

              <View style={styles.linkRow}>
                <View style={styles.linkMain}>
                  <Text variant="rowTitle">Anyone with the link</Text>
                  <Text variant="meta" style={styles.linkNote}>
                    {describeOpenLink(openLink !== undefined)}
                  </Text>
                </View>
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

              {/*
                What a typed name actually does, said once, where the field's
                own outcome is decided — rather than as a third heading with a
                paragraph under it.
              */}
              <Text variant="meta" style={styles.linkNote}>
                {describePersonalShare()}
              </Text>
            </View>

            {advanced !== undefined ? (
              <View style={styles.section}>
                <Text variant="eyebrow">ADVANCED</Text>
                {advanced}
              </View>
            ) : null}
          </ScrollView>

          <View style={styles.actions}>
            <Button label="Done" onPress={onClose} />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * Making a group without leaving the note.
 *
 * A label and a set of people, and nothing else — no role, no description, no
 * nesting. A group here is a *name a folder rule can point at*; everything
 * else about it is decided in the Groups panel, which is where renaming one and
 * dropping somebody from every folder at once still live.
 *
 * The assembled name is shown as you type because **the prefix is not yours to
 * enter** — `buildGroupName` derives it from the workspace slug, so a field
 * that accepted `supa-leads` would produce `@supa-supa-leads`. Same reasoning,
 * and the same words, as `GroupsPanel`'s greyed prefix.
 */
function GroupMaker({
  slug,
  members,
  state,
  onChange,
  onCancel,
  onCreate,
}: {
  slug: string;
  members: readonly AccessMember[];
  state: { label: string; picked: string[] };
  onChange: (next: { label: string; picked: string[] }) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const ready = canMakeGroup(state.label, state.picked);

  return (
    <View style={styles.maker} testID="share-group-maker">
      <View style={styles.row}>
        <TextInput
          value={state.label}
          onChangeText={(label) => onChange({ ...state, label })}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          placeholder="Group name"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Group name"
        />
        <Button label="Create" variant="white" disabled={!ready} onPress={onCreate} />
        <Button label="Cancel" onPress={onCancel} />
      </View>

      <Text variant="meta" style={styles.suggestionDetail}>
        {`Will be ${previewGroupName(slug, state.label)} — the prefix is this context's, not yours to type.`}
      </Text>

      {/*
        Every member, with the ones already picked marked. Not `addableMembers`
        — that excludes who is already in an existing group, and this group does
        not exist yet.
      */}
      <View style={styles.pickList}>
        {members.map((member) => {
          const on = state.picked.includes(member.userId);
          return (
            <Pressable
              key={member.userId}
              style={[styles.pick, on && styles.pickOn]}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={memberLabel(member)}
              testID={`share-group-pick-${member.userId}`}
              onPress={() =>
                onChange({
                  ...state,
                  picked: on
                    ? state.picked.filter((id) => id !== member.userId)
                    : [...state.picked, member.userId],
                })
              }
            >
              <Text variant="meta" style={on ? undefined : styles.suggestionMuted}>
                {`${on ? "✓ " : ""}${memberLabel(member)}`}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
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
  accessMain: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  accessReason: { color: colors.muted },
  /* Row plus whatever it has expanded, so the divider stays on the row. */
  accessGroup: { gap: 0 },
  routes: {
    gap: 2,
    marginBottom: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    overflow: "hidden",
  },
  route: { paddingVertical: 9, paddingHorizontal: 10, gap: 1 },
  routeDanger: { color: colors.crit },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  linkMain: { flexGrow: 1, flexShrink: 1, minWidth: 160, gap: 1 },
  linkNote: { color: colors.muted },
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
  /*
    A scroll surface with a ceiling, so the sheet cannot grow past the screen.
    It used to be a plain `View`: with three prose sections, a shared-with list
    and an advanced block, the Done button left the bottom of a phone entirely.
  */
  body: { maxHeight: 460 },
  bodyContent: { gap: 16, paddingBottom: 4 },
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
  makeGroup: {
    paddingVertical: 9,
    paddingHorizontal: 10,
    gap: 2,
    borderRadius: radii.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
  },
  maker: {
    gap: 8,
    padding: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.well,
  },
  pickList: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pick: {
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  /* An answer rather than an offer: on the well, so it does not read as a button. */
  suggestionReaching: { backgroundColor: colors.well },
  suggestionMuted: { color: colors.text2 },
  suggestionDetail: { color: colors.muted },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  previewText: { flexGrow: 1, flexShrink: 1 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
});
