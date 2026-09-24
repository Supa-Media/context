/**
 * Who can read this note, and everything you can do about it — in one sheet.
 *
 * ## What this screen is for, and why it is wordier than a Share sheet usually
 * is
 *
 * A share here is not "anyone with the link". It is a named person, who signs
 * in, and who can then read **this note and the notes it links to** — depth
 * one, decided in `functions/shares.ts`. Every part of that is something an
 * owner would guess wrong if the dialog just said "Share":
 *
 *  - They would expect a link anybody could open, and be surprised their
 *    colleague was asked to sign in.
 *  - They would *not* expect the linked notes to come with it, which is the
 *    part that can hand over more than they meant.
 *  - They would not know the note's name travels to the unfurl before anybody
 *    signs in.
 *
 * So each is stated next to the control it belongs to, in the words it costs.
 * The wording lives in `shares.ts` and `scope.ts` — testable, and unable to
 * drift from what the server actually does.
 *
 * ## Every line you can read here, you can act on
 *
 * That is the rule this sheet was rebuilt around, because it was the one thing
 * it did not do. It listed the people with access as three strings with no
 * control on them; it could point at a group but not make one; and whether a
 * note had a public link was decided in two places — here, and by an
 * unlabelled padlock in the top bar that minted the same share row on its
 * third press. So the sheet explained the situation accurately and offered
 * almost no way out of it.
 *
 * Now: the audience is a named control at the head of the people list; each
 * person carries the routes that would actually take their access away, with
 * the blast radius on each; a group can be made from the people in front of
 * you; and the links section hands you a link rather than minting one.
 *
 * ## The order is the order somebody works in
 *
 * The field is first — it is what people come here to use — and everything
 * else is context for it, so context goes after. No `autoFocus`: the sheet has
 * to be readable before it is typed into, and a keyboard over it is not that.
 * Then who can read it, then who it has been handed to, then links.
 *
 * ## Nothing here decides authorization
 *
 * Whether this dialog can be reached at all is `canShare` in `capabilities.ts`
 * (owner-only), and the server refuses anyone else with `minimum: "owner"`.
 * Every optional callback below follows the console's standing rule — a
 * control somebody may not use is **absent, not disabled** — and the
 * validation here is about not sending a request certain to fail, never about
 * permission.
 */

import { useState } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles } from "../../design/theme";
import { densityFor } from "../../app/frame";
import { baseName, folderLabel } from "./paths";
import { accessRows } from "./access";
import { noMatchHint, recipientsFor } from "./recipients";
import { isGroupVisibility } from "./types";
import { sharesFor } from "./shares";
import { LinksSection } from "./shareDialog/LinksSection";
import type { ShareDialogProps } from "./shareDialog/props";
import { RecipientPicker } from "./shareDialog/RecipientPicker";
import { makeStyles } from "./shareDialog/styles";
import { WhoCanRead } from "./shareDialog/WhoCanRead";

export function ShareDialog({
  path,
  shares,
  origin,
  onShare,
  onCopyLink,
  onRevoke,
  onSetSlug,
  onSetCollecting,
  onSetPreviewTitle,
  onClose,
  advanced,
  access,
  onShareWithGroup,
  onRemovalRoute,
  onCreateGroup,
  groupSlug,
  entryKind = "file",
  onSetScope,
  groups,
  context = { slug: null, kind: null, viewerIsOwner: true },
}: ShareDialogProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  /*
    `densityFor` rather than a width of this file's own, for the reason
    `Menu.web.tsx` gives at length: the width at which a popover becomes a
    sheet is the width at which the app stops being a pointer layout, and it is
    one threshold named once. This is console code, so it says the console's
    name for it.
  */
  const view = useWindowDimensions();
  const compact = densityFor(view.width) === "compact";
  /*
    HOW TALL THE SHEET MAY GROW, WHICH IS NOT 460.

    `body`'s fixed ceiling was written for a centred card with a 20pt gutter
    above and below it, and as a bottom sheet on an 844pt phone it left the
    links section — the half `Phone-Share.dc.html` is a picture of — below the
    fold with 250pt of scrim doing nothing above it. A sheet is measured
    against the screen it comes up from, so it is measured against the screen:
    roughly two thirds, which leaves the note it is about visible behind the
    scrim rather than covering the whole phone.
  */
  const bodyCeiling = Math.round(view.height * 0.66);
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
  /** Why the last Create was refused, or `null`. Shown inside the maker. */
  const [makeProblem, setMakeProblem] = useState<string | null>(null);

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
  /*
    Which link a name would be attached to.

    A short link is a second address for a row that already exists, so it
    needs one. The unlisted link first, because that is the one people paste
    where a memorable URL matters; the workspace link otherwise, which is the
    useful case for a team handbook. When there is neither, the block is
    absent rather than offering to name nothing — the same rule the "Anyone
    with the link" row beside it follows.
  */
  const namedLink = openLink ?? mine?.find((share) => share.audience === "members");
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
      : accessRows(
          access.visibility,
          access.exception,
          access.members,
          entryKind,
          isGroupVisibility(access.visibility)
            ? groups?.find((group) => `@${group.name}` === access.visibility)?.liveCount
            : undefined,
        );
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
      <Pressable
        style={[styles.scrim, compact && styles.scrimSheet]}
        accessibilityLabel="Close"
        onPress={onClose}
      >
        <Pressable
          style={[styles.card, compact && styles.sheet]}
          onPress={() => {}}
          accessibilityLabel={`Share ${folderLabel(baseName(path))}`}
        >
          {/*
            A SHEET ON A PHONE, A CARD EVERYWHERE ELSE.

            `Phone-Share.dc.html` draws this anchored to the bottom edge with a
            grab handle — which is what every other modal surface on this phone
            already is (`Menu.web.tsx` draws a bottom sheet below
            `layout.narrowBreakpoint`, and `RecentSheet` is one), and what this
            dialog alone was not. A centred card on a 390pt screen is a card
            that arrives from nowhere and sits under the thumb's reach, with
            its own scrim gap either side of it doing nothing.

            The handle is drawn and inert: it is the affordance that says
            "this came up from the bottom, it goes back down", and this sheet
            is dismissed by the scrim and by Done rather than by a drag. A
            handle that can be dragged is a gesture to build, not a rectangle;
            what it must not be is absent, because then the sheet reads as a
            panel that has always been there.
          */}
          {compact ? <View style={styles.handle} aria-hidden /> : null}
          {/*
            Named without its sort number, the way the row this was opened
            from is: a heading reading `1-projects` over a row reading
            `projects` reads as a different folder. Nothing here is addressed
            by this string — the share rows below carry the real `path`, and a
            minted link is a token rather than a path.
          */}
          <Text variant="paneTitle" role="heading" aria-level={2}>
            Share “{folderLabel(baseName(path))}”
          </Text>

          <ScrollView
            style={[styles.body, compact && { maxHeight: bodyCeiling }]}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
          >
            <RecipientPicker
              colors={colors}
              recipient={recipient}
              setRecipient={setRecipient}
              submit={submit}
              ready={ready}
              onShare={onShare}
              onShareWithGroup={onShareWithGroup}
              onCreateGroup={onCreateGroup}
              groupSlug={groupSlug}
              access={access}
              making={making}
              setMaking={setMaking}
              makeProblem={makeProblem}
              setMakeProblem={setMakeProblem}
              emptyHint={emptyHint}
              suggestions={suggestions}
            />

            <WhoCanRead
              path={path}
              access={access}
              entryKind={entryKind}
              context={context}
              compact={compact}
              openLink={openLink}
              rows={rows}
              removing={removing}
              setRemoving={setRemoving}
              onSetScope={onSetScope}
              onRemovalRoute={onRemovalRoute}
              mine={mine}
              origin={origin}
              copyAndClose={copyAndClose}
              onRevoke={onRevoke}
              onSetPreviewTitle={onSetPreviewTitle}
            />

            <LinksSection
              path={path}
              entryKind={entryKind}
              context={context}
              problem={problem}
              openLink={openLink}
              namedLink={namedLink}
              copyAndClose={copyAndClose}
              onRevoke={onRevoke}
              onSetCollecting={onSetCollecting}
              onSetSlug={onSetSlug}
            />

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
