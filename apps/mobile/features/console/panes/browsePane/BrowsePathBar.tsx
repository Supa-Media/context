import { StyleSheet, View } from "react-native";
import { layout } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../../files/browser";
import { PresencePile } from "../../presence/PresencePile";
import type { Presence } from "../../presence/usePresence";
import type { entryAt } from "../../files/tree";

/**
 * What a phone draws above a note or a folder: who else is in the note, and
 * nothing else.
 *
 * It was the path — the workspace's pill, then every folder down to the page —
 * and the owner's review of the phone Home took it out (2026-10-01): *"I dont
 * think we need to show the file path at the top of notes anymore"*. Each thing
 * it did went somewhere it belongs. The way up is the ‹ back button at the top
 * left (`home/phoneBack.ts`), which names the folder above; the workspace's
 * mark is the account button on Home (`SwitcherMenu`'s phone trigger); the
 * page names itself, a note in its title and a folder in its head.
 *
 * The presence pile stays, at the trailing edge, because it is the one fact on
 * the row nothing else says: somebody else is in this note with you.
 */
export function BrowsePathBar({
  files,
  selected,
  presence,
}: {
  files: FileBrowser;
  selected: ReturnType<typeof entryAt>;
  /** The open note's room, for the pile. */
  presence?: Presence;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    Only for the note the editor holds: the room is that note's, and the
    selection can move ahead of it.
  */
  if (presence === undefined || selected?.kind !== "file" || files.editor.path !== selected.path) return null;
  return (
    <View style={styles.row} testID="phone-presence-row">
      <PresencePile presence={presence} compact />
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    row: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: layout.readingMargin },
  });
