/**
 * A folder's about note, under its title as a subtitle: the folder's
 * `about.md` (or the older `overview.md`, `index.md`, `README.md`, which mean
 * the same; the top of the workspace's is its front page, `index.md`).
 *
 * Redesigned by the owner's call on 2026-10-09 ("I hate how the about.md
 * looks… sometimes about will be long, sometimes short"), replacing the
 * whole note drawn at note size with its filename in the corner:
 *
 * - **The opening words only** (`aboutSnippet.ts`), as plain text at body
 *   size in the quiet colour: two lines on a desktop page, three on a phone.
 *   No box, no filename, no headings.
 * - **Read more**, only when something is left out or cut, opens the whole
 *   note: beside the page in the side panel where it fits (`AboutPanel.tsx`,
 *   where a writer types in it through the console's one editor), else in a
 *   sheet (`AboutSheet.tsx`). On a phone the words themselves are the button.
 * - **Edit**, for somebody who may write: the opening paragraph becomes a
 *   field in place (`LedeEditor.tsx`). An about that opens with a list or a
 *   heading is edited as a whole note instead, since its line is not a
 *   paragraph one could type back.
 * - A folder with no words yet offers "Add a short description" to a writer
 *   and nothing to a reader; it creates `about.md` where there is none.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { FolderListSource } from "../listBlock/model";
import { aboutSnippet } from "./aboutSnippet";
import { ledeSource } from "./lede";
import { Lede, type LedeEditing } from "./LedeEditor";
import { usePanelBody } from "./panel/usePanelBody";

/** The lines the words get before Read more: a subtitle on a desktop page, a little more on a phone. */
export const LINES = { desk: 2, phone: 3 } as const;
/** An average character of the body face, for whether the words fill their lines. */
const CHARACTER = 7.6;
const PROMPT = "Add a short description";

export function AboutBlock({
  path,
  title,
  source,
  compact,
  create,
  setLede,
  onReadMore,
}: {
  /** The about note, or null when the folder has none. */
  path: string | null;
  /** The page's title, which a first heading repeating it is not read again under. */
  title: string;
  source: FolderListSource | undefined;
  /** A phone's page: three lines, and the words open the rest. */
  compact: boolean;
  /** For a folder with no about note: creates one with the sentence typed. Null for a reader. */
  create: LedeEditing | null;
  /** Writes the about note's opening paragraph; null for a reader. */
  setLede: ((path: string, text: string) => Promise<string | null>) | null;
  /** Shows the whole note, editable where the page can lend its editor. */
  onReadMore: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = usePanelBody(source, path);
  const [width, setWidth] = useState(0);
  const [typing, setTyping] = useState<string | null>(null);

  if (path === null) return create === null ? null : <Lede text={null} editing={create} prompt={PROMPT} />;
  if (body.kind === "loading" || body.kind === "none") return null;
  const text = body.kind === "text" ? body.text : "";
  const snippet = body.kind === "text" ? aboutSnippet(text, title) : null;
  const writable = setLede !== null && body.kind === "text";
  const paragraph: LedeEditing | null = !writable
    ? null
    : { read: async () => ledeSource(text), save: (next) => setLede(path, next) };

  if (snippet === null || (snippet.text === "" && !snippet.more)) {
    // An about with nothing in it yet, such as the empty one New folder writes.
    return paragraph === null ? null : <Lede text={null} editing={paragraph} prompt={PROMPT} />;
  }
  // Another note's field stays its own: a folder change while typing starts over.
  if (typing === path && paragraph !== null) {
    return <Lede text={snippet.text} editing={paragraph} autoOpen onClose={() => setTyping(null)} prompt={PROMPT} />;
  }

  const lines = compact ? LINES.phone : LINES.desk;
  const perLine = width > 0 ? Math.floor(width / CHARACTER) : Infinity;
  const more = snippet.more || snippet.text.length > perLine * lines;
  const readMore = () => onReadMore(path);
  const edit = () => (snippet.kind === "paragraph" ? setTyping(path) : readMore());
  const words =
    snippet.text === "" ? null : (
      <Text
        variant="body"
        numberOfLines={lines}
        style={styles.words}
        // Said to a screen reader, which would read cut words as if they were all of them.
        {...(more ? { accessibilityLabel: `${snippet.text} (continues)` } : {})}
        testID="folder-about-words"
      >
        {isolateForDisplay(snippet.text)}
      </Text>
    );

  return (
    <View style={styles.box} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} testID="folder-about">
      {compact && more && words !== null ? (
        <Pressable onPress={readMore} accessibilityRole="button" accessibilityLabel={`About ${title}, read all`} style={styles.tap} testID="folder-about-open">
          {words}
        </Pressable>
      ) : (
        words
      )}
      {more || writable ? (
        <View style={styles.actions}>
          {more ? (
            <Action label={compact ? "More" : snippet.text === "" ? "About this folder ›" : "Read more ›"} onPress={readMore} accent testID="folder-about-more" />
          ) : null}
          {writable ? <Action label="Edit" onPress={edit} testID="folder-about-edit" /> : null}
        </View>
      ) : null}
    </View>
  );
}

function Action({ label, onPress, accent = false, testID }: { label: string; onPress: () => void; accent?: boolean; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole="button"
      hitSlop={8}
      style={styles.action}
      testID={testID}
    >
      <Text variant="treeMeta" style={[accent ? styles.accent : styles.quiet, hovered && styles.hovered]}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { marginTop: space.x1 },
    words: { color: colors.muted },
    tap: { minHeight: 44, justifyContent: "center" },
    actions: { flexDirection: "row", alignItems: "center", gap: space.x4, marginTop: space.x1 },
    action: { paddingVertical: 2 },
    accent: { color: colors.accent, fontWeight: "600" },
    quiet: { color: colors.chromeMuted },
    hovered: { textDecorationLine: "underline" },
  });
