import { StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { describeSyncMark, type SyncMark } from "./pendingMarks";

/**
 * The mark on a row whose note has not reached the bucket.
 *
 * Drawn on the tree, the folder page and the Recent sheet — every list a
 * person picks a note from — so "which three?" has an answer on the surface
 * they are already looking at rather than only in a sentence in the strip.
 *
 * ## Why this shape
 *
 * These rows already carry a 7pt disc: the folder page's exception pip, in
 * accent, muted or violet. A second disc in a different colour would be told
 * apart by hue alone, and amber beside violet is exactly the pair a reader who
 * cannot separate colours loses. So the two marks differ in *shape* first:
 *
 *  - **waiting to sync** is a ring — an outline with nothing inside it, which
 *    is the state: written down here, not yet there. `warn`.
 *  - **needs you** is the same ring with a dot at its centre — a target,
 *    the heaviest mark a row carries, in `crit`, and a shape neither the
 *    exception pip (a plain disc) nor the waiting ring has. It outranks the ring the way "need you" outranks
 *    "waiting" everywhere else (`queueLine`).
 *
 * Neither is pressable: the row it sits on already opens the note, and opening
 * the note is how a waiting write is checked and a parked one is answered.
 *
 * The accessible name is the words, always — a mark only sighted people get
 * is not a mark. It is `role="img"` so the name is announced where the mark
 * sits outside a labelled control; where it sits inside one (a `PressRow`
 * names itself), the caller adds the same words to the row's own name, because
 * a button's name replaces its children's.
 */
export function SyncMarkDot({ mark }: { mark: SyncMark }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      role="img"
      accessibilityLabel={describeSyncMark(mark)}
      style={[styles.mark, mark === "conflict" ? styles.conflict : styles.queued]}
      testID={`sync-mark-${mark}`}
    >
      {mark === "conflict" ? <View style={styles.core} /> : null}
    </View>
  );
}

/**
 * A row's accessible name with its sync state appended — `"plan, waiting to
 * sync"` — or unchanged when there is none. One helper so the three lists say
 * it in the same words and the same position.
 */
export function withSyncMark(label: string, mark: SyncMark | null | undefined): string {
  return mark == null ? label : `${label}, ${describeSyncMark(mark)}`;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  mark: {
    width: 11,
    height: 11,
    borderRadius: 6,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    flexGrow: 0,
    flexShrink: 0,
  },
  queued: { borderColor: colors.warn },
  conflict: { borderColor: colors.crit },
  core: { width: 3, height: 3, borderRadius: 2, backgroundColor: colors.crit },
});
