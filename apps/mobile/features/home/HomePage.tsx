import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { ScreenScroll } from "../app/Screen";
import type { FileBrowser } from "../console/files/browser";
import { NoteEditor } from "../console/files/NoteEditor";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { leading, pointerType as t } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { noteTitle, parseNote } from "../share/markdown";
import { NoteBody } from "../share/NoteBody";

const noop = () => {};

/**
 * The open note, read as the site draws it: its title where the editor draws
 * one, and the body beneath, with its links working. `onEdit` puts an Edit
 * button beside the title; a page with nothing to edit (an unknown address)
 * gets none.
 */
export function HomePage({
  markdown,
  compact,
  onLink,
  onEdit,
}: {
  markdown: string;
  compact: boolean;
  onLink: (href: string) => void;
  onEdit?: () => void;
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
        {title === null && onEdit === undefined ? null : (
          <View style={styles.titleRow}>
            <Text variant="body" role="heading" aria-level={1} style={styles.title}>
              {title ?? ""}
            </Text>
            {onEdit === undefined ? null : (
              <Button label="Edit" variant="mini" onPress={onEdit} testID="home-edit" />
            )}
          </View>
        )}
        <NoteBody blocks={blocks} onSiteLink={onLink} />
      </View>
    </ScreenScroll>
  );
}

/**
 * The open note in the app's own editor, as a workspace member would write in
 * it. What is typed goes to the tab's copy of the workspace only
 * (`useLocalFileBrowser`), which the line above the editor says, so nobody
 * thinks they just changed the site.
 */
export function HomeEditor({
  files,
  compact,
  onDone,
  onOpenNote,
}: {
  files: FileBrowser;
  compact: boolean;
  onDone: () => void;
  onOpenNote: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.editing, compact && styles.editingCompact]} testID="home-editor">
      <View style={styles.editBar}>
        <Text variant="body" style={styles.hint}>
          Your changes stay in this browser. Reload to see the site again.
        </Text>
        <Button label="Done" variant="mini" onPress={onDone} testID="home-done" />
      </View>
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
    titleRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 16 },
    title: {
      flexShrink: 1,
      fontSize: t.title,
      lineHeight: leading(t.title, 1.2),
      fontWeight: "600",
      color: colors.text,
      letterSpacing: -0.4,
    },
    editing: { flex: 1, backgroundColor: colors.pageSurface },
    editingCompact: { paddingTop: 64 },
    editBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
      paddingHorizontal: 24,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    hint: { flexShrink: 1, fontSize: t.ui, color: colors.muted },
  });
