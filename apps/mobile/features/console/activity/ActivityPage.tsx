import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { pointerType as t, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ActivityList } from "./ActivityList";
import { ACTIVITY_PATH, emptyLine, type ActivityView } from "./activity";

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
 */
export function ActivityPage({
  activity,
  onOpen,
  shared,
  now,
}: {
  activity: ActivityView;
  onOpen: (path: string) => void;
  /** Whether anybody else is in this context — it changes the empty state. */
  shared: boolean;
  now: number;
}) {
  const styles = useThemedStyles(sheet);
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text variant="noteTitle" style={styles.title}>
        Activity
      </Text>
      <Text variant="hint" style={styles.lede}>
        What has changed in this context, newest first — by the people in it and
        by the AI clients they have connected. Paths and names only; what a note
        says stays in the note.
      </Text>
      <ActivityList
        entries={activity.entries}
        seenAt={activity.seenAt}
        now={now}
        empty={emptyLine(shared)}
        onOpen={onOpen}
      />
      <View style={styles.foot}>
        <Text variant="treeMeta" style={styles.footText}>
          This page is {ACTIVITY_PATH}, a note in your own storage. Every line
          here is a line in that file, and it leaves with the rest of your
          context.
        </Text>
      </View>
    </ScrollView>
  );
}

const sheet = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.pageSurface },
    content: {
      paddingHorizontal: space.x7,
      paddingTop: space.x8,
      paddingBottom: space.x8,
      maxWidth: 760,
      width: "100%",
    },
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
  });
