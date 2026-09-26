import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { ScreenScroll } from "../app/Screen";
import type { FileBrowser } from "../console/files/browser";
import { NoteEditor } from "../console/files/NoteEditor";
import { Text } from "../design/components/Text";
import { layout, leading, pointerType as t, space } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { noteTitle, parseNote } from "../share/markdown";
import { NoteBody } from "../share/NoteBody";

const noop = () => {};

/**
 * A page that is not a note: the shell's own answer for an address the site
 * does not have, drawn as the site draws a page, with its links working.
 */
export function HomePage({
  markdown,
  compact,
  onLink,
}: {
  markdown: string;
  compact: boolean;
  onLink: (href: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { title, blocks } = useMemo(() => {
    const parsed = parseNote(markdown).blocks;
    const own = noteTitle(parsed);
    return own === null ? { title: null, blocks: parsed } : { title: own, blocks: parsed.slice(1) };
  }, [markdown]);

  return (
    <ScreenScroll
      style={styles.page}
      contentContainerStyle={[styles.pageContent, compact && styles.pageContentCompact]}
      testID="home-page"
    >
      <View style={styles.column}>
        {title === null ? null : (
          <Text variant="body" role="heading" aria-level={1} style={styles.title}>
            {title}
          </Text>
        )}
        <NoteBody blocks={blocks} onSiteLink={onLink} />
      </View>
    </ScreenScroll>
  );
}

/**
 * The open note in the app's own editor, writable the moment it opens, as it
 * is for a workspace member. What is typed goes to the tab's copy of the
 * workspace only (`useLocalFileBrowser`), and a reload is the site again.
 * Nothing on screen says so: the owner asked for the page to just work, with
 * no instructions over it.
 */
/**
 * The band a workspace note has over it on a pointer layout, kept empty.
 *
 * In the console the note's path sits above its title (`BrowseNoteHead`: the
 * breadcrumb's `space.x4` over a 24pt row of `‹ ›` steps, `space.x2` under,
 * and never less than a touch target). The homepage has no path to show, and
 * without the band its title sat that much higher than the same note in the
 * editor (the owner's report, 2026-09-26). So the height is kept and the words
 * are not.
 */
export const NOTE_HEAD_BAND = Math.max(layout.minTouchTarget, space.x4 + 24 + space.x2);

export function HomeEditor({
  files,
  compact,
  onOpenNote,
}: {
  files: FileBrowser;
  compact: boolean;
  onOpenNote: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.editing, compact ? styles.editingCompact : styles.editingPointer]} testID="home-editor">
      <NoteEditor
        state={files.editor}
        canEdit={files.canEdit}
        onChange={files.setDraft}
        onSave={files.save}
        onDiscard={files.discard}
        onUseTheirs={noop}
        onKeepMine={noop}
        onOpenNote={onOpenNote}
        onLoadImage={files.loadImage}
        onStoreImage={files.storeImage}
        onImageProblem={files.say}
        onSubmitForm={files.submitForm}
        notePaths={files.linkPaths}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.pageSurface },
    pageContent: { paddingHorizontal: 24, paddingTop: 48, paddingBottom: 96 },
    // Below the phone's floating top row, which the page scrolls behind.
    pageContentCompact: { paddingTop: 80 },
    column: { width: "100%", maxWidth: 680, alignSelf: "center", gap: 16 },
    title: {
      fontSize: t.title,
      lineHeight: leading(t.title, 1.2),
      fontWeight: "600",
      color: colors.text,
      letterSpacing: -0.4,
    },
    editing: { flex: 1, backgroundColor: colors.pageSurface },
    // Below the phone's floating top row.
    editingCompact: { paddingTop: 64 },
    editingPointer: { paddingTop: NOTE_HEAD_BAND },
  });
