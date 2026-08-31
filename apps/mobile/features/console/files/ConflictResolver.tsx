import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { markedConflicts } from "../../offline/merge";
import {
  CHOICES,
  CONFLICT_HEADLINE,
  CONFLICT_REASSURANCE,
  REVIEW,
  checkedAgainst,
  proposalLine,
} from "../../offline/resolution";
import { LiveEditor } from "./LiveEditor";
import type { ConflictReview } from "./useConflictReview";

/**
 * Answering a conflict: three choices, and nothing written until one is made.
 *
 * ## Why this replaces the note rather than sitting under it
 *
 * A conflict used to be a two-line strip below the editor with two buttons on
 * it. That is the right shape for a *notice* and the wrong one for a
 * *decision*: this surface has to show both versions, propose a merge, and let
 * somebody edit that proposal before it is saved. None of that fits in a strip,
 * and a strip that opened a modal over the note would be two places to make one
 * decision.
 *
 * So while the open note is in conflict, the editor region **is** this. The
 * tree, the tabs and the rail are all outside it, so nothing about this blocks
 * reading or editing anything else — which was the objection to blocking the
 * editor recorded in CLAUDE.md, and it is answered by where this is drawn
 * rather than by adding a dismiss button that leads back to a worse version of
 * the same question.
 *
 * ## What each control does, in one line each
 *
 *  - **Keep theirs** discards the draft and loads the bucket's version. It
 *    writes nothing.
 *  - **Keep mine** writes the draft over the version shown above it,
 *    conditionally on that version.
 *  - **Merge them** proposes a three-way merge, and **shows it for review** in
 *    an editable document. Nothing is saved until "Save this version".
 *
 * The third is absent, with its reason said out loud, when there is no common
 * ancestor to merge against. See `offline/resolution.ts`.
 *
 * ## The look
 *
 * Obsidian's, like the rest of the console: paper, ink, a 16/24 reading
 * measure, 25pt side margins, and the controls floating over an edge-to-edge
 * scroll rather than penned into a bar. Colours come through
 * `useThemedStyles`, so both palettes are drawn from the same factory and
 * neither is hardcoded here.
 */
export function ConflictResolver({
  review,
  onKeepTheirs,
  onResolveWith,
}: {
  review: ConflictReview;
  /** Discard the draft and load the bucket's version. Writes nothing. */
  onKeepTheirs: () => void;
  /** Save this text, conditionally on the version the review showed. */
  onResolveWith: (text: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = densityFor(useWindowDimensions().width) === "compact";

  /**
   * The proposal under review, or `null` while the choices are on screen.
   *
   * Local, and deliberately not lifted into the editor's state: until somebody
   * presses save this text exists nowhere but in front of them, which is the
   * literal form of "nothing is written until you choose". The draft they typed
   * is untouched in the queue the whole time, so nothing is at risk in keeping
   * it here.
   */
  const [proposal, setProposal] = useState<string | null>(null);

  /*
    A second conflict on the same note — they chose, the write was refused
    because somebody wrote a third time — is a different decision about
    different text. Dropping the proposal puts them back on the choices with
    the fresh versions, rather than leaving a merge of two versions that are
    no longer the two versions.
  */
  useEffect(() => setProposal(null), [review.theirsEtag, review.path]);

  const marked = useMemo(
    () => (proposal === null ? 0 : markedConflicts(proposal)),
    [proposal],
  );

  const footer = checkedAgainst(review.conditionalWrite);

  if (proposal !== null) {
    return (
      <View style={styles.region}>
        <View style={[styles.head, compact && styles.headCompact]}>
          <Text variant="paneTitle" role="heading" aria-level={2}>
            Review the merge
          </Text>
          <Text variant="paneSub" style={styles.lede}>
            {proposalLine(marked)}
          </Text>
        </View>

        <View style={styles.document}>
          <LiveEditor
            value={proposal}
            editable
            onChange={setProposal}
            onSave={() => onResolveWith(proposal)}
            accessibilityLabel={`${review.path} merged markdown`}
          />
        </View>

        <View style={[styles.floating, compact && styles.floatingCompact]}>
          <Button
            label={REVIEW.save.label}
            variant="white"
            onPress={() => onResolveWith(proposal)}
            testID="conflict-save-merge"
          />
          <Button label={REVIEW.back.label} onPress={() => setProposal(null)} />
          <Text variant="meta" style={styles.footerLine}>
            {footer}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.region}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.page, compact && styles.pageCompact]}
      >
        <Text variant="paneTitle" role="heading" aria-level={2}>
          {CONFLICT_HEADLINE}
        </Text>
        <Text variant="paneSub" style={styles.lede}>
          {CONFLICT_REASSURANCE}
        </Text>
        {review.message === undefined ? null : (
          <Text variant="meta" style={styles.said}>
            {review.message}
          </Text>
        )}

        <View style={[styles.versions, compact && styles.versionsStacked]}>
          <Version title="Yours, on this device" body={review.mine} />
          <Version
            title="Theirs, in your bucket"
            body={review.theirs}
            /*
              Never an empty box. A blank panel labelled "theirs" reads as "they
              deleted everything", which is the one wrong answer this screen
              could give somebody about to press a button.
            */
            absent={
              review.reading
                ? "Reading it now…"
                : (review.unreadable ??
                  "Not read yet — there is no connection, so only your version is here.")
            }
          />
        </View>

        <View style={styles.choices}>
          <Choice
            label={CHOICES.theirs.label}
            detail={CHOICES.theirs.detail}
            onPress={onKeepTheirs}
            /*
              Refused rather than offered-and-broken while the bucket's version
              is unread: this is the one control that destroys somebody's
              typing, and pressing it to adopt a version nobody has seen is not
              a choice, it is a coin toss. Offline it stays out of reach and the
              panel above says why.
            */
            disabled={review.theirs === null}
            testID="conflict-keep-theirs"
          />
          <Choice
            label={CHOICES.mine.label}
            detail={CHOICES.mine.detail}
            onPress={() => onResolveWith(review.mine)}
            testID="conflict-keep-mine"
          />
          {review.merge === null ? (
            <View style={styles.choice}>
              <Text variant="hint" style={styles.refusal}>
                {review.mergeRefusal?.sentence}
              </Text>
            </View>
          ) : (
            <Choice
              label={CHOICES.merge.label}
              detail={CHOICES.merge.detail}
              onPress={() => setProposal(review.merge?.text ?? null)}
              testID="conflict-merge"
            />
          )}
        </View>

        <Text variant="meta" style={styles.footerLine}>
          {footer}
        </Text>
      </ScrollView>
    </View>
  );
}

/** One version of the note, at reading size, in a box that says whose it is. */
function Version({
  title,
  body,
  absent,
}: {
  title: string;
  body: string | null;
  absent?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.version}>
      <Text variant="railHead">{title}</Text>
      <ScrollView style={styles.versionBody} contentContainerStyle={styles.versionInner}>
        {body === null ? (
          <Text variant="hint">{absent}</Text>
        ) : (
          <Text style={styles.reading}>{body}</Text>
        )}
      </ScrollView>
    </View>
  );
}

/** A button and the sentence that says what pressing it will do. */
function Choice({
  label,
  detail,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  detail: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.choice}>
      <Button
        label={label}
        onPress={onPress}
        disabled={disabled}
        style={styles.choiceButton}
        testID={testID}
      />
      <Text variant="paneSub" style={styles.choiceDetail}>
        {detail}
      </Text>
    </View>
  );
}

/**
 * The reading measure, spelled out once.
 *
 * 16 on a 24 line box in 25 of side margin — the same three numbers the note
 * itself is drawn at, because this screen is where somebody reads two versions
 * of that note and a different measure would make them reflow differently from
 * the document they came out of.
 */
const READING = { size: 16, line: 24, margin: 25 } as const;

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  region: { flex: 1, minHeight: 0, backgroundColor: colors.surface },
  scroll: { flex: 1, minHeight: 0 },

  page: {
    paddingHorizontal: READING.margin,
    paddingTop: space.x5,
    paddingBottom: space.x8,
    gap: space.x3,
    maxWidth: 760,
  },
  pageCompact: { maxWidth: undefined },

  lede: { maxWidth: 560 },
  /** Whatever the refusal itself said, kept but demoted below our own sentence. */
  said: { marginTop: -space.x1 },

  versions: { flexDirection: "row", gap: space.x3, marginTop: space.x2 },
  versionsStacked: { flexDirection: "column" },
  version: { flex: 1, minWidth: 0, gap: space.x1 },
  versionBody: {
    maxHeight: 220,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
  },
  versionInner: { paddingVertical: space.x3, paddingHorizontal: space.x4 },
  reading: {
    fontFamily: fonts.body,
    fontSize: READING.size,
    lineHeight: READING.line,
    color: colors.text,
  },

  choices: { marginTop: space.x3, gap: space.x3 },
  choice: { gap: space.x1 },
  choiceButton: { alignSelf: "flex-start" },
  choiceDetail: { maxWidth: 560 },
  refusal: { maxWidth: 560 },

  footerLine: { marginTop: space.x3, maxWidth: 560 },

  /* --------------------------- the review surface ------------------------ */

  head: {
    paddingHorizontal: READING.margin,
    paddingTop: space.x5,
    paddingBottom: space.x3,
    gap: space.x1,
  },
  headCompact: { paddingTop: space.x3 },
  /** The document runs to the edges; its own margin is `LiveEditor`'s. */
  document: { flex: 1, minHeight: 0 },

  /**
   * The controls lie over the note rather than being ruled off from it.
   *
   * `chrome` plus a shadow, which is how everything else that floats in this
   * app reads as above the page — a border would make it a bar, and a bar is
   * what this deliberately is not.
   */
  floating: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.x2,
    margin: space.x3,
    paddingVertical: space.x3,
    paddingHorizontal: space.x4,
    borderRadius: radii.floating,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
  },
  floatingCompact: { margin: space.x2 },
});
