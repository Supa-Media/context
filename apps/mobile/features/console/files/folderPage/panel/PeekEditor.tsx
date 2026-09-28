/**
 * The note's words in the side peek, editable: the console's own editor's
 * note (`peekEditing.ts`), drawn by the same `LiveEditor` its page uses and
 * wired the way its page wires it (`noteEditor/document.tsx`) — a keystroke
 * goes to the collaboration room when the note has one and to the editor's
 * draft otherwise, so the autosave, the save mark, the unsaved-changes guard
 * and the conflict are the page's own.
 *
 * The frontmatter stays in the file and out of sight until the caret goes
 * into it, as on the page (`livePreview.ts`); the values above are how the
 * peek changes it. A conflict is not answered here: it takes reading two
 * versions, which is the note's own page (`ConflictResolver`), one press away.
 */

import { StyleSheet, View } from "react-native";
import { Button } from "../../../../design/components/Button";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { LiveEditor } from "../../LiveEditor";
import type { FolderListSource } from "../../listBlock/model";
import type { NoteLinkOpen } from "../../noteLinks";
import type { PeekEditing } from "./peekEditing";

/** The editor's reading line, 16pt at 1.75 (`liveEditorWeb/stylesheet.ts`), and its padding. */
const LINE = 28;
const EDGES = 32;
/** An average character of the reading face, for how many fit on a line. */
const CHARACTER = 8;
/** Room under the last line to keep typing into before the box grows. */
const ROOM = 3;
const MOST = 160;

/** How tall the box is for `text` at `width`: every line wrapped, and a little room to type. */
export function editorHeight(text: string, width: number): number {
  const perLine = Math.max(20, Math.floor(width / CHARACTER));
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.min(MOST, lines + ROOM) * LINE + EDGES;
}

export function PeekEditor({
  editing,
  path,
  title,
  width,
  source,
  onOpenNote,
  onExpand,
}: {
  editing: PeekEditing;
  /** The note the editor holds (`editsHere` said so). */
  path: string;
  title: string;
  width: number;
  source: FolderListSource | undefined;
  onOpenNote: (path: string, mode: NoteLinkOpen) => void;
  /** The note's own page, where a conflict is answered. */
  onExpand: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { editor, presence } = editing;
  if (editor.status === "conflict") {
    return (
      <View style={styles.conflict} role="alert" testID="task-panel-conflict">
        <Text variant="tree" style={styles.conflictText}>
          Somebody else saved this note while you were typing. Your words are kept; open it to choose which version to keep.
        </Text>
        <Button label="Open to choose" variant="mini" onPress={onExpand} testID="task-panel-conflict-open" />
      </View>
    );
  }
  const shared = presence?.collaboration;
  // As on the page: nobody types before the room has the note, or they would type into nothing.
  const editable = shared?.ready !== false;
  const text = shared?.text ?? editor.draft;
  return (
    <View style={[styles.body, { height: editorHeight(text, width) }]} testID="task-panel-body">
      <LiveEditor
        value={editor.draft}
        editable={editable}
        presence={presence}
        onChange={(next) => (shared?.onChange ?? editing.onChange)(next)}
        onVersionedChange={shared === undefined ? undefined : (next, base) => shared.onVersionedChange(next, base)}
        documentRevision={shared?.revision}
        onSave={editing.onSave}
        accessibilityLabel={`${title}, editing`}
        notePath={path}
        onOpenNote={onOpenNote}
        folderLists={source}
        {...(editing.onLoadImage === undefined ? {} : { onLoadImage: editing.onLoadImage })}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The editor brings its own margins; the panel's padding is its measure.
    body: { marginHorizontal: -space.x2 },
    conflict: { gap: space.x3, alignItems: "flex-start", padding: space.x4, borderRadius: 8, backgroundColor: colors.critWash },
    conflictText: { color: colors.critText },
  });
