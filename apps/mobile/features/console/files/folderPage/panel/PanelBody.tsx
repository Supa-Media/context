/**
 * The note's words, in the side panel, drawn by the console's own editor so
 * a note looks here as it does on its own page — headings, lists, links,
 * tables — rather than as a second rendering of Markdown.
 *
 * **Editable for somebody who may write** (the owner, 2026-09-28, reversing
 * the read-only peek of the same day). Not by a second editor: the console
 * holds one open note — one draft, one autosave, one unsaved-changes guard,
 * one conflict, one collaboration room — and a second editable editor would
 * be a second writer of the file outside all of it. The peek borrows *that*
 * editor instead (`peekEditing.ts`): opening the panel on a note puts the note
 * in it, as if it had been opened from the tree, and closing the panel or
 * moving to another row gives it back, the draft written first. The note's
 * words are then the editor's, typed into exactly as on its page
 * (`PeekEditor.tsx`). Until it has them — and for a member, and a note that
 * is locked or not a note one types in — they are read as before, read-only.
 *
 * The frontmatter is not drawn — the values above say it — nor a first
 * heading that is only the title again (`panelText`). An encrypted note says
 * it is locked; a note this device has not got says so.
 */

import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { space } from "../../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../../design/theme";
import { LiveEditor } from "../../LiveEditor";
import type { FolderListSource } from "../../listBlock/model";
import type { NoteLinkOpen } from "../../noteLinks";
import { panelText } from "./panelModel";
import { usePanelBody } from "./usePanelBody";
import { editsHere, type PeekEditing } from "./peekEditing";
import { PeekEditor } from "./PeekEditor";

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
  editing,
  onExpand,
}: {
  source: FolderListSource | undefined;
  /** The note whose words these are (`bodyPath`); null for a folder with no front note. */
  path: string | null;
  /** The title drawn above, which a first heading repeating it is not drawn again under. */
  title: string;
  width: number;
  onOpenNote: (path: string, mode: NoteLinkOpen) => void;
  /** The console's editor, lent to the peek; absent for a member and wherever there is none to lend. */
  editing?: PeekEditing;
  /** The note's own page. */
  onExpand?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = usePanelBody(source, path);
  const open = editing?.canEdit === true ? editing.open : undefined;
  const close = editing?.canEdit === true ? editing.close : undefined;
  // The note goes into the editor while it is shown here, and comes back out when it is not.
  useEffect(() => {
    if (path === null || open === undefined || close === undefined) return;
    open(path);
    return () => void close(path);
  }, [path, open, close]);
  if (path !== null && editsHere(editing, path)) {
    return (
      <PeekEditor
        editing={editing}
        path={path}
        title={title}
        width={width}
        source={source}
        onOpenNote={onOpenNote}
        onExpand={onExpand ?? (() => onOpenNote(path, "foreground"))}
      />
    );
  }
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
