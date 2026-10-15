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
 * - **The words are the way in**, for somebody who may write: pressing them
 *   turns the opening paragraph into a field in place (`LedeEditor.tsx`).
 *   There was an Edit button beside Read more until the owner, 2026-10-14:
 *   "I don't like that I had to click on edit in order to edit an about".
 *   An about that opens with a list or a heading opens the whole note
 *   instead, since its line is not a paragraph one could type back.
 * - **It never jumps in.** The words are read from the bucket, which answers
 *   after the page has drawn, so until they arrive the block keeps their room:
 *   the opening paragraph the device's copy already holds (`hint`), drawn as
 *   is, else two invisible lines and the Read more line under them. What
 *   arrives into an empty room fades in over `motion.layoutMs` rather than
 *   pushing the list down a frame after the page appeared (the owner,
 *   2026-10-14: "it's fine for the about to come in later, but we should
 *   leave space for it").
 * - A folder with no words yet offers "Add a short description" to a writer
 *   and nothing to a reader; it creates `about.md` where there is none.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { motion, radii, space } from "../../../design/tokens";
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
/** A line's characters before the block has been measured: about a desktop column's. */
const WIDE = 80;

export function AboutBlock({
  path,
  title,
  source,
  compact,
  create,
  setLede,
  onReadMore,
  hint = null,
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
  /** The about's opening paragraph as the device's copy has it, drawn while the note itself is read. */
  hint?: string | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = usePanelBody(source, path);
  const [width, setWidth] = useState(0);
  const [typing, setTyping] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  // Whether this note's room was last held empty while it was read: what arrives then fades in.
  const held = useRef<string | null>(null);
  const lines = compact ? LINES.phone : LINES.desk;

  if (path === null) return create === null ? null : <Lede text={null} editing={create} prompt={PROMPT} />;
  const perLine = width > 0 ? Math.floor(width / CHARACTER) : Infinity;
  if (body.kind === "loading") {
    const words = hint === null || hint.trim() === "" ? null : hint;
    // What was last held decides: words already drawn are not faded in again.
    held.current = words === null ? path : null;
    // Read more's line is held too, unless the words to hand plainly fit their lines.
    const moreLine = words === null || words.length > (width > 0 ? perLine : WIDE) * lines;
    return (
      <View style={styles.box} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} aria-hidden testID="folder-about-waiting">
        <Text variant="body" numberOfLines={lines} style={[styles.words, words === null && styles.unseen]}>
          {words === null ? FILLER : isolateForDisplay(words)}
        </Text>
        {moreLine ? (
          <View style={[styles.actions, styles.unseen]}>
            <Text variant="treeMeta" style={styles.action}>
              {"Read more ›"}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }
  if (body.kind === "none") return null;
  const fade = held.current === path;
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

  const more = snippet.more || snippet.text.length > perLine * lines;
  const readMore = () => onReadMore(path);
  const edit = () => (snippet.kind === "paragraph" ? setTyping(path) : readMore());
  const words =
    snippet.text === "" ? null : (
      <Text
        variant="body"
        numberOfLines={lines}
        style={[styles.words, hovered && styles.wordsHover]}
        // Said to a screen reader, which would read cut words as if they were all of them.
        {...(more ? { accessibilityLabel: `${snippet.text} (continues)` } : {})}
        testID="folder-about-words"
      >
        {isolateForDisplay(snippet.text)}
      </Text>
    );

  return (
    <FadeIn on={fade}>
      <View style={styles.box} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} testID="folder-about">
        {words !== null && writable ? (
          // A writer's words are the field's way in: pressed, they become it, in place.
          <Pressable
            onPress={edit}
            onHoverIn={() => setHovered(true)}
            onHoverOut={() => setHovered(false)}
            accessibilityRole="button"
            accessibilityLabel={snippet.kind === "paragraph" ? `Edit description, ${snippet.text}` : `About ${title}, open to edit`}
            style={[styles.press, compact && styles.tap]}
            testID="folder-about-edit"
          >
            {words}
          </Pressable>
        ) : compact && more && words !== null ? (
          <Pressable onPress={readMore} accessibilityRole="button" accessibilityLabel={`About ${title}, read all`} style={styles.tap} testID="folder-about-open">
            {words}
          </Pressable>
        ) : (
          words
        )}
        {more ? (
          <View style={styles.actions}>
            <Action label={compact ? "More" : snippet.text === "" ? "About this folder ›" : "Read more ›"} onPress={readMore} accent testID="folder-about-more" />
          </View>
        ) : null}
      </View>
    </FadeIn>
  );
}

/** Two lines' worth of nothing: the room the words take, held while they are read. */
const FILLER = "\u00a0\n\u00a0";

/** Its children, faded in once over the console's one duration when `on`; drawn as they are otherwise. */
function FadeIn({ on, children }: { on: boolean; children: ReactNode }) {
  const opacity = useRef(new Animated.Value(on ? 0 : 1)).current;
  useEffect(() => {
    if (!on) return;
    Animated.timing(opacity, { toValue: 1, duration: motion.layoutMs, useNativeDriver: false }).start();
  }, [on, opacity]);
  return on ? <Animated.View style={{ opacity }} testID="folder-about-fade">{children}</Animated.View> : <>{children}</>;
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
    wordsHover: { color: colors.text2 },
    // Held room: laid out, never seen.
    unseen: { opacity: 0 },
    // The hover tint and the field share the Lede's inset, so pressing moves no word.
    press: { marginHorizontal: -6, paddingHorizontal: 6, borderRadius: radii.sm, cursor: "text" as never },
    tap: { minHeight: 44, justifyContent: "center" },
    actions: { flexDirection: "row", alignItems: "center", gap: space.x4, marginTop: space.x1 },
    action: { paddingVertical: 2 },
    accent: { color: colors.accent, fontWeight: "600" },
    quiet: { color: colors.chromeMuted },
    hovered: { textDecorationLine: "underline" },
  });
