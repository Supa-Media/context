/**
 * The note's words, in the side panel: drawn by the console's own editor,
 * read-only, so a note looks here as it does on its own page — headings,
 * lists, links, tables — rather than as a second rendering of Markdown.
 *
 * **Read-only for everybody, a writer too, and that is a decision.** The
 * console holds one open note: one draft, one autosave, one unsaved-changes
 * guard, one conflict to resolve, and one collaboration room that the people
 * typing in it share (`docs/decisions/collaboration.md`). A second editable
 * editor here would be a second writer of the same file outside all of that
 * — an edit that bypasses the room is the lost keystroke the room exists to
 * prevent. Expand opens the note where it is edited. A second *read-only*
 * editor holds nothing and writes nothing, so it can sit beside the first.
 *
 * The frontmatter is not drawn — the values above say it — nor a first
 * heading that is only the title again (`panelText`). An encrypted note says
 * it is locked; a note this device has not got says so.
 */

import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { LiveEditor } from "../../LiveEditor";
import type { FolderListSource } from "../../listBlock/model";
import type { NoteLinkOpen } from "../../noteLinks";
import { panelText } from "./panelModel";
import { usePanelBody } from "./usePanelBody";

/** The editor's reading line, 16pt at 1.75 (`liveEditorWeb/stylesheet.ts`). */
const LINE = 28;
/** The editor's own padding above and below the text. */
const EDGES = 32;
/** An average character of the reading face, for how many fit on a line. */
const CHARACTER = 8;
/** The fewest lines the box keeps, and the most before it scrolls itself. */
const FEWEST = 2;
const MOST = 160;

/**
 * How tall the words are, near enough: the editor fills the box it is given
 * rather than growing with its text, so the box is sized to the text — each
 * line, wrapped at the panel's width. Where the guess is short the editor
 * scrolls the rest; the panel itself scrolls the page of it.
 */
export function bodyHeight(text: string, width: number): number {
  const perLine = Math.max(20, Math.floor(width / CHARACTER));
  const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.min(MOST, Math.max(FEWEST, lines)) * LINE + EDGES;
}

export function PanelBody({
  source,
  path,
  title,
  width,
  onOpenNote,
}: {
  source: FolderListSource | undefined;
  /** The note whose words these are (`bodyPath`); null for a folder with no front note. */
  path: string | null;
  /** The title drawn above, which a first heading repeating it is not drawn again under. */
  title: string;
  width: number;
  onOpenNote: (path: string, mode: NoteLinkOpen) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = usePanelBody(source, path);
  if (body.kind === "none") return null;
  if (body.kind === "loading") return <View style={styles.loading} testID="task-panel-body-loading" />;
  if (body.kind !== "text") {
    return (
      <Text variant="treeMeta" style={styles.note} testID="task-panel-body-note">
        {body.kind === "locked"
          ? "This note is locked. Expand to open it."
          : "This note’s words are not on this device yet."}
      </Text>
    );
  }
  const text = panelText(body.text, title);
  if (text.trim() === "") {
    return (
      <Text variant="treeMeta" style={styles.note} testID="task-panel-body-note">
        Nothing written here yet.
      </Text>
    );
  }
  return (
    <View style={[styles.body, { height: bodyHeight(text, width) }]} testID="task-panel-body">
      <LiveEditor
        value={text}
        editable={false}
        onChange={ignore}
        onSave={ignore}
        accessibilityLabel={`${title}, read only`}
        notePath={path}
        onOpenNote={onOpenNote}
        folderLists={source}
      />
    </View>
  );
}

function ignore(): void {}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The editor brings its own margins; the panel's padding is its measure.
    body: { marginHorizontal: -space.x2 },
    loading: { minHeight: LINE * FEWEST },
    note: { color: colors.muted },
  });
