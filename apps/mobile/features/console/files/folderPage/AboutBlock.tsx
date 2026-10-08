/**
 * A folder's about note, drawn at the top of its page: the words of its
 * `about.md` (or the older `overview.md`, `index.md`, `README.md`, which mean
 * the same; the top of the workspace's is its front page, `index.md`), with
 * the filename in the corner so it reads as the file it is. Decided by the
 * owner on 2026-10-08, from the folder-about boards.
 *
 * The words are drawn by the panel's own body (`panel/PanelBody.tsx`): the
 * console's editor, read-only, without the frontmatter or a first heading
 * that only repeats the title. Pressed by somebody who may write, they become
 * editable in place through the same lent editor the side peek types into,
 * never a second one; "Done" gives it back. The filename opens the note on
 * its own page. A folder with no about note offers "Add a description" to a
 * writer, which creates `about.md` with that sentence (`LedeEditor.tsx`).
 *
 * Long words fold: past `FOLD` the box stops, fades out and offers "Show all",
 * so a long note never pushes the folder's own notes off the screen; "Show
 * less" folds it back. Editing always shows the whole note.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { gradient } from "../../../design/css";
import { withAlpha } from "../../../design/color";
import { fonts } from "../../../design/tokens/typography";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { FolderListSource } from "../listBlock/model";
import type { NoteLinkOpen } from "../noteLinks";
import { baseName } from "../paths";
import { Lede, type LedeEditing } from "./LedeEditor";
import { PanelBody } from "./panel/PanelBody";
import { editsHere, type PeekEditing } from "./panel/peekEditing";

/** About five lines of the editor's 28pt reading line, plus its own padding. */
export const FOLD = 172;
/** The width the words are sized for until the box has been laid out: a note's measure. */
const MEASURE = 640;
/** How much taller than the fold the words must be before folding is worth a button. */
const SLACK = 24;

export function AboutBlock({
  path,
  title,
  source,
  editing,
  create,
  onOpenNote,
}: {
  /** The about note, or null when the folder has none. */
  path: string | null;
  /** The page's title, which a first heading repeating it is not drawn again under. */
  title: string;
  source: FolderListSource | undefined;
  /** The console's editor, lent to this page; absent for a member and where there is none. */
  editing?: PeekEditing;
  /** For a folder with no about note: creates one with the sentence typed. Null for a reader. */
  create: LedeEditing | null;
  onOpenNote: (path: string, mode: NoteLinkOpen) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  // Another folder is another note: nothing carries over.
  useEffect(() => {
    setOpen(false);
    setActive(false);
    setHeight(0);
  }, [path]);

  if (path === null) return create === null ? null : <Lede text={null} editing={create} />;

  const writable = editing?.canEdit === true;
  const typing = active && editsHere(editing, path);
  const long = height > FOLD + SLACK;
  const folded = long && !open && !active;
  return (
    <View style={styles.box} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} testID="folder-about">
      <View style={styles.corner}>
        {active ? (
          <Pressable onPress={() => setActive(false)} accessibilityRole="button" style={styles.chip} testID="folder-about-done">
            <Text variant="treeMeta" style={styles.done}>
              Done
            </Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => onOpenNote(path, "foreground")}
          accessibilityRole="link"
          accessibilityLabel={`Open ${baseName(path)}`}
          style={styles.chip}
          testID="folder-about-file"
        >
          <Text variant="treeMeta" style={styles.file}>
            {baseName(path)}
          </Text>
        </Pressable>
      </View>
      <Pressable
        disabled={!writable || active}
        onPress={() => setActive(true)}
        accessibilityLabel={writable && !active ? "Edit the folder's description" : undefined}
        style={[styles.words, folded && styles.folded]}
        testID="folder-about-words"
      >
        <View onLayout={(event) => setHeight(event.nativeEvent.layout.height)}>
          <PanelBody
            source={source}
            path={path}
            title={title}
            width={width > 0 ? width : MEASURE}
            onOpenNote={onOpenNote}
            empty={writable ? "Add a description" : null}
            {...(active && editing !== undefined ? { editing } : {})}
          />
        </View>
        {folded ? <View pointerEvents="none" style={styles.fade} /> : null}
      </Pressable>
      {long && !active ? (
        <Pressable onPress={() => setOpen((was) => !was)} accessibilityRole="button" style={styles.more} testID="folder-about-more">
          <Text variant="treeMeta" style={styles.moreText}>
            {open ? "Show less" : "Show all"}
          </Text>
        </Pressable>
      ) : null}
      {active && !typing ? (
        <Text variant="treeMeta" style={styles.waiting}>
          Opening for editing…
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { marginTop: space.x2 },
    corner: { position: "absolute", right: 0, top: -space.x6, flexDirection: "row", gap: space.x1, zIndex: 1 },
    chip: { paddingHorizontal: space.x2, paddingVertical: 2, borderRadius: radii.sm, backgroundColor: colors.chipFill },
    file: { fontFamily: fonts.mono, color: colors.muted, fontSize: 12 },
    done: { color: colors.accent, fontWeight: "600" },
    words: { borderRadius: radii.sm },
    folded: { maxHeight: FOLD, overflow: "hidden" },
    fade: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      height: 56,
      ...gradient(`linear-gradient(to bottom, ${withAlpha(colors.pageSurface, 0)}, ${colors.pageSurface})`),
    },
    more: {
      alignSelf: "flex-start",
      marginTop: space.x1,
      paddingHorizontal: space.x3,
      paddingVertical: space.x1,
      borderRadius: radii.pill,
      backgroundColor: withAlpha(colors.accent, 0.12),
    },
    moreText: { color: colors.accent, fontWeight: "600" },
    waiting: { color: colors.muted, marginTop: space.x1 },
  });
