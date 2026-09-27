import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { noteColumnWidth } from "../../app/frame";
import { writeClipboard } from "../../design/clipboard";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { layout, pointerType as t, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ActivityList } from "./ActivityList";
import { useOrganizerUndoFor } from "../../organizer/OrganizerContext";
import {
  ACTIVITY_PATH,
  emptyLine,
  repairPrompt,
  strayRows,
  type ActivityView,
} from "./activity";

/**
 * `activity.md`, opened.
 *
 * The console's file tree lists it like any other note, a tab holds it like
 * any other note, and a link to it is a link to a note — because it **is** a
 * note, in the customer's own bucket, in Markdown. What this replaces is only
 * the editor: a list of dated lines is a thing to read rather than a thing to
 * type into, and the raw file's machine comments are noise to everybody except
 * the parser.
 *
 * ## Why a viewer rather than a page of its own
 *
 * The alternative was a route — `/console/@name/activity` — and it was built
 * and thrown away. A route makes activity a *place*, which is what the meeting
 * that asked for this explicitly did not ask for; worse, it makes the file and
 * the screen two different things, so a person who opens `activity.md` in the
 * tree lands in a text editor full of HTML comments and wonders which one is
 * real. This way there is one answer: the file is real, and this is how the
 * console draws it. `isDrawingPath` is the same trade for `.excalidraw`.
 *
 * The line at the foot says so out loud, because a rendering that hides what
 * it is rendering is how a product ends up owning somebody's data by accident.
 *
 * ## The column is the note's column
 *
 * `noteColumnWidth` and `layout.notePadX`, centred — the same measure and the
 * same gutters `LiveEditor` spends in CSS and `noteGutterFor` describes. Not a
 * resemblance: pressing the pencil here swaps this list for that editor over
 * the same file, and a page that drew its own column would jump sideways at
 * the press. It was a hard 760 pinned to the left edge, which is the state the
 * screenshot that asked for this was of.
 */
export function ActivityPage({
  activity,
  onOpen,
  shared,
  now,
  source,
  editable = false,
}: {
  activity: ActivityView;
  onOpen: (path: string) => void;
  /** Whether anybody else is in this context — it changes the empty state. */
  shared: boolean;
  now: number;
  /**
   * The file as stored, for the one question the entries cannot answer: has
   * somebody edited a row so that it is no longer a row? See `strayRows`.
   */
  source?: string;
  /**
   * Whether this reader may open the Markdown — `canEditActivity`.
   *
   * Only decides whether the foot line mentions the pencil. A member who is
   * told to press a control they do not have is worse off than one who is told
   * nothing.
   */
  editable?: boolean;
}) {
  const styles = useThemedStyles(sheet);
  const undoFor = useOrganizerUndoFor();
  const [copied, setCopied] = useState(false);
  /*
    Counted from the file in hand rather than from the entries: the whole point
    is the rows that are *in the file* and did not become entries.

    Memoised because this walks every line of a file that is allowed to reach
    400 entries, and the notice's own `copied` state re-renders the page. A
    member never gets here with anything in `source` — they cannot read the
    file, only the rendering — so the empty string is the ordinary case and
    answers zero.
  */
  const stray = useMemo(() => strayRows(source ?? ""), [source]);
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <View style={styles.column}>
        <Text variant="noteTitle" style={styles.title}>
          Activity
        </Text>
        <Text variant="hint" style={styles.lede}>
          What has changed in this context, newest first — by the people in it
          and by the AI clients they have connected. Paths and names only; what
          a note says stays in the note.
        </Text>
        <ActivityList
          entries={activity.entries}
          seenAt={activity.seenAt}
          now={now}
          empty={emptyLine(shared)}
          undoFor={undoFor}
          onOpen={onOpen}
        />
        {stray > 0 ? (
          /*
            SOMEBODY EDITED THE MACHINE'S HALF, AND IS TOLD RATHER THAN STOPPED.

            Nothing here refuses anything — see `strayRows`. These lines are
            still in the file and will still be there in Obsidian; what they
            are not is rows, because the `<!--ctx …-->` copy is what a row is
            read from, and the region they sit in is rebuilt on the next
            change. Saying nothing is how a person edits a file, watches rows
            disappear, and concludes the product ate them.

            A button that swept them up was the obvious alternative and is the
            wrong one: a one-press "fix" that deletes what somebody typed is
            the product taking the file back the moment it looks untidy, in a
            feature whose entire subject is that the file is theirs. So it
            hands over the words to ask an AI client for, and the person
            decides.
          */
          <View style={styles.repair} testID="activity-stray">
            <Text variant="treeMeta" style={styles.repairText}>
              {stray === 1
                ? "One line between the markers has lost the comment Context reads it from, so it is not shown above and will go when the next change is recorded."
                : `${stray} lines between the markers have lost the comment Context reads them from, so they are not shown above and will go when the next change is recorded.`}{" "}
              Anything you write outside the markers is kept.
            </Text>
            <PressRow
              accessibilityLabel="Copy a prompt for your AI client"
              role="button"
              onPress={() => {
                void writeClipboard(repairPrompt()).then((ok) => setCopied(ok));
              }}
              style={styles.repairButton}
              testID="activity-stray-copy"
            >
              <Text variant="treeMeta" style={styles.repairAction}>
                {copied ? "Copied — paste it to your AI client" : "Copy a prompt to fix it"}
              </Text>
            </PressRow>
          </View>
        ) : null}
        <View style={styles.foot}>
          <Text variant="treeMeta" style={styles.footText}>
            This page is {ACTIVITY_PATH}, a note in your own storage. Every line
            here is a line in that file, and it leaves with the rest of your
            context.
            {editable
              ? " Open it as Markdown with the pencil above — what you write outside the two markers is kept, and Context never rewrites it."
              : null}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const sheet = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.pageSurface },
    /*
      `alignItems` on the container and the measure on a child inside it, rather
      than `alignSelf` on the container itself: a vertical `ScrollView`'s
      content container is its own flex parent, and `alignSelf` there is the
      arrangement that draws centred on web and hard left on native. This one
      is the same on both.
    */
    content: {
      alignItems: "center",
      paddingHorizontal: layout.notePadX,
      paddingTop: space.x8,
      paddingBottom: space.x8,
      width: "100%",
    },
    /** The note's measure, so the pencil does not move the text sideways. */
    column: { width: "100%", maxWidth: noteColumnWidth },
    title: { color: colors.text, marginBottom: space.x2 },
    lede: {
      color: colors.chromeMuted,
      marginBottom: space.x5,
      lineHeight: t.body,
    },
    foot: {
      marginTop: space.x6,
      paddingTop: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    footText: { color: colors.chromeMuted },
    repair: {
      marginTop: space.x5,
      padding: space.x3,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.chipFill,
      gap: space.x2,
    },
    repairText: { color: colors.text2 },
    repairButton: { alignSelf: "flex-start", paddingVertical: space.x1 },
    repairAction: { color: colors.accentText },
  });
