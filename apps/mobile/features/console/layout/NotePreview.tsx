import { useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { editedLabel, wordRuns } from "../../design/components/PaletteResultRow";
import { fonts, pointerType, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { PaletteItem } from "../files/palette";

/** Reads one note's Markdown, as `files.readNote` does. */
export type NoteReader = (workspaceId: string, path: string) => Promise<{ text: string; encrypted?: boolean }>;

/** One block of a note as the preview draws it: a heading, or a line of text. */
export interface PreviewBlock {
  heading: boolean;
  text: string;
}

/** About a screen of reading: enough to know it is the right note, never the whole of a long one. */
const PREVIEW_CHARS = 1400;
const PREVIEW_BLOCKS = 14;
/** Arrowing through the list reads only the row it stops on. */
const SETTLE_MS = 120;

/**
 * A note's Markdown as plain blocks: front matter off, headings kept as
 * headings, list marks as bullets, link targets and emphasis marks dropped.
 * Plain text rather than rendered Markdown because this is a glance at the
 * words, and the editor is one Enter away.
 */
export function previewBlocks(markdown: string): PreviewBlock[] {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const blocks: PreviewBlock[] = [];
  let used = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || /^(```|---|\|[-: |]+\|$)/.test(line)) continue;
    const heading = /^#{1,6}\s/.test(line);
    const text = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+\[[ xX]\]\s+/, "• ")
      .replace(/^[-*+]\s+/, "• ")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[\[([^\]|]*)(\|([^\]]*))?\]\]/g, (_all, target: string, _bar, label?: string) => label ?? target)
      .replace(/(\*\*|__|`)/g, "");
    if (text === "") continue;
    const room = PREVIEW_CHARS - used;
    if (room <= 0 || blocks.length >= PREVIEW_BLOCKS) break;
    blocks.push({ heading, text: text.length > room ? `${text.slice(0, room).trimEnd()}…` : text });
    used += text.length;
  }
  return blocks;
}

/**
 * The blocks without a first heading that only repeats the title drawn above
 * them: most notes open with their own name as `# Heading`, and saying it
 * twice pushes the words somebody came for down the column.
 */
export function withoutTitle(blocks: PreviewBlock[], title: string): PreviewBlock[] {
  const [first, ...rest] = blocks;
  if (first === undefined || !first.heading) return blocks;
  const a = first.text.trim().toLowerCase();
  const b = title.trim().toLowerCase();
  // Whole words only: a note called "Plan" keeps a heading "Planning ahead".
  return a !== "" && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `)) ? rest : blocks;
}

type Read = { state: "reading" } | { state: "read"; blocks: PreviewBlock[]; encrypted: boolean } | { state: "failed" };

/**
 * The highlighted search answer, read beside the list (board B1): where it is,
 * its name, when it was written, and its first screen of words with the ones
 * typed in bold. A note that cannot be read here falls back to its snippet,
 * so the column never says less than the row did.
 */
export function NotePreview({ item, query, read }: { item: PaletteItem; query: string; read: NoteReader }) {
  const styles = useThemedStyles(makeStyles);
  const cache = useRef(new Map<string, Read>());
  const workspaceId = item.workspace?.id;
  const key = workspaceId === undefined ? null : `${workspaceId}/${item.id}`;
  const [shown, setShown] = useState<Read>({ state: "reading" });

  useEffect(() => {
    if (key === null || workspaceId === undefined) return;
    const known = cache.current.get(key);
    if (known !== undefined) {
      setShown(known);
      return;
    }
    setShown({ state: "reading" });
    let live = true;
    const timer = setTimeout(() => {
      read(workspaceId, item.id).then(
        (note) => {
          const done: Read = {
            state: "read",
            blocks: note.encrypted ? [] : withoutTitle(previewBlocks(note.text), item.label),
            encrypted: note.encrypted === true,
          };
          cache.current.set(key, done);
          if (live) setShown(done);
        },
        () => {
          if (live) setShown({ state: "failed" });
        },
      );
    }, SETTLE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, workspaceId, item.id, item.label, read]);

  const words = query.split(/[^\p{L}\p{N}]+/u);
  const marked = (text: string, style: object) =>
    wordRuns(text, words).map((run, index) =>
      run.matched ? (
        <Text key={index} style={[style, styles.mark]}>
          {run.text}
        </Text>
      ) : (
        run.text
      ),
    );
  // The place as the row says it ("@acme · Projects/launch"), not the raw path.
  const where = item.detail ?? "";

  return (
    <ScrollView style={styles.pane} contentContainerStyle={styles.content} testID="note-preview">
      <Text variant="treeMetaMono" numberOfLines={1}>
        {where}
      </Text>
      <Text style={styles.title} numberOfLines={3}>
        {item.label}
      </Text>
      {item.edited === undefined ? null : (
        <Text variant="treeMeta" style={styles.edited}>
          {editedLabel(item.edited).replace(/^edited/, "Edited")}
        </Text>
      )}
      <View style={styles.body}>
        {shown.state === "read" && shown.encrypted ? (
          <Text variant="rowSub">This note is encrypted. Open it to read it.</Text>
        ) : shown.state === "read" && shown.blocks.length > 0 ? (
          shown.blocks.map((block, index) => (
            <Text key={index} style={block.heading ? styles.heading : styles.line}>
              {marked(block.text, block.heading ? styles.heading : styles.line)}
            </Text>
          ))
        ) : shown.state === "read" ? (
          <Text variant="rowSub">This note is empty.</Text>
        ) : item.snippet ? (
          <Text style={[styles.line, shown.state === "reading" && styles.waiting]}>{marked(item.snippet, styles.line)}</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pane: { flex: 1 },
    content: { paddingHorizontal: space.x6, paddingVertical: space.x5 },
    title: { fontFamily: fonts.reading, fontSize: pointerType.h2, lineHeight: 30, fontWeight: "700", color: colors.text, marginTop: space.x2 },
    edited: { marginTop: space.x1 },
    body: { marginTop: space.x4, gap: space.x3 },
    heading: { fontFamily: fonts.reading, fontSize: pointerType.body, lineHeight: 24, fontWeight: "700", color: colors.text },
    line: { fontFamily: fonts.reading, fontSize: pointerType.lede, lineHeight: 24, color: colors.text2 },
    mark: { color: colors.text, fontWeight: "700" },
    waiting: { opacity: 0.6 },
  });
