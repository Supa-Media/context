import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { chatBlocks, type ChatBlock, type ChatInline } from "./appChatMarkdown";
import { textPieces } from "./appChatText";

/** Opens an `https:` link in a new tab. Nothing else in the chat is tappable. */
function openLink(href: string): void {
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(href, "_blank", "noopener,noreferrer");
  }
}

export interface TexChatWordsProps {
  text: string;
  /** The person's own words are plain text with https links; Tex's are Markdown. */
  mine: boolean;
  /**
   * Opens one of the person's notes inside the app. With none, a note link
   * opens its own address in a new tab instead.
   */
  onOpenNote?: ((href: string, path: string) => void) | null;
}

/**
 * The words of one chat bubble.
 *
 * Draws what it is given and decides nothing. A message from Tex is drawn as
 * Markdown (`chatBlocks`), so a list, bold or a note card reads as it was
 * written. The person's own words stay plain, with only `https:` links
 * tappable, so nothing they type is ever reformatted.
 *
 * Every piece of text carries its bubble's colour explicitly: the design `Text`
 * paints its own default colour otherwise, which put white on the accent.
 */
export function TexChatWords({ text, mine, onOpenNote }: TexChatWordsProps) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const ink = mine ? styles.inkMine : styles.inkTheirs;

  if (mine) {
    return (
      <Text style={[styles.body, ink]} selectable>
        {textPieces(text).map((piece, index) =>
          piece.kind === "link" ? (
            <Text
              key={index}
              onPress={() => openLink(piece.href)}
              accessibilityRole="link"
              style={[styles.link, ink]}
            >
              {piece.value}
            </Text>
          ) : (
            <Text key={index} style={ink}>
              {piece.value}
            </Text>
          ),
        )}
      </Text>
    );
  }

  const open = (href: string, path: string, url: string) => {
    if (onOpenNote) onOpenNote(href, path);
    else openLink(url);
  };

  return (
    <View style={styles.stack}>
      {chatBlocks(text).map((block, index) => (
        <BlockView key={index} block={block} ink={ink} styles={styles} open={open} />
      ))}
    </View>
  );
}

type Open = (href: string, path: string, url: string) => void;
type InkStyle = { color: string };

function BlockView({ block, ink, styles, open }: { block: ChatBlock; ink: InkStyle; styles: Styles; open: Open }) {
  const colors = useColors();
  switch (block.kind) {
    case "paragraph":
      return (
        <Text style={[styles.body, ink]} selectable>
          <Runs content={block.content} ink={ink} styles={styles} open={open} />
        </Text>
      );
    case "heading":
      return (
        <Text style={[styles.body, styles.heading, ink]} selectable>
          <Runs content={block.content} ink={ink} styles={styles} open={open} />
        </Text>
      );
    case "bullet":
    case "ordered":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.item}>
              {block.kind === "bullet" ? (
                // A drawn dot: the font's "•" renders a speck at this size.
                <View style={[styles.dot, { backgroundColor: ink.color }]} />
              ) : (
                <Text style={[styles.marker, ink]}>{`${index + 1}.`}</Text>
              )}
              <Text style={[styles.body, ink]} selectable>
                <Runs content={item} ink={ink} styles={styles} open={open} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "notecard":
      return (
        <Pressable
          onPress={() => open(block.href, block.path, block.url)}
          accessibilityRole="button"
          accessibilityLabel={`Open ${block.title}`}
          style={styles.card}
          testID="tex-notecard"
        >
          <Icon name="file" size={16} color={colors.muted} />
          <View style={styles.cardText}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {block.title}
            </Text>
            {block.folder !== "" ? (
              <Text style={styles.cardFolder} numberOfLines={1}>
                {block.folder}
              </Text>
            ) : null}
          </View>
          <Text style={styles.cardOpen}>Open</Text>
        </Pressable>
      );
  }
}

/** A run of inline pieces inside one Text. */
function Runs({ content, ink, styles, open }: { content: ChatInline[]; ink: InkStyle; styles: Styles; open: Open }) {
  return (
    <>
      {content.map((run, index) => {
        const marks = [run.kind !== "code" && run.strong === true && styles.strong, run.kind !== "code" && run.em === true && styles.em];
        switch (run.kind) {
          case "code":
            return (
              <Text key={index} style={[styles.code, ink]}>
                {run.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={index}
                onPress={() => openLink(run.href)}
                accessibilityRole="link"
                style={[styles.link, ink, marks]}
              >
                {run.text}
              </Text>
            );
          case "note":
            return (
              <Text
                key={index}
                onPress={() => open(run.href, run.path, run.url)}
                accessibilityRole="link"
                style={[styles.noteLink, marks]}
                testID="tex-notelink"
              >
                {run.text}
              </Text>
            );
          case "text":
            return (
              <Text key={index} style={[ink, marks]}>
                {run.text}
              </Text>
            );
        }
      })}
    </>
  );
}

export type Styles = ReturnType<typeof makeStyles>;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { maxWidth: "100%", gap: 6 },
    // The approved mock's sizes: 14 on a 20 line, not the page's own body scale.
    body: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
    heading: { fontWeight: "600" },
    inkMine: { color: colors.ink },
    inkTheirs: { color: colors.text },
    muted: { color: colors.muted },
    strong: { fontWeight: "600" },
    em: { fontStyle: "italic" },
    link: { textDecorationLine: "underline" },
    noteLink: {
      color: colors.accentText,
      fontWeight: "500",
      // Inline text cannot take a border, so the note's accent underline is the nearest honest mark.
      textDecorationLine: "underline",
      textDecorationColor: colors.accentText,
    },
    code: {
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: 18,
      borderRadius: 4,
      backgroundColor: colors.surface3,
      color: colors.text,
    },
    list: { paddingLeft: 18, gap: 2 },
    item: { position: "relative" },
    dot: { position: "absolute", left: -12, top: 8, width: 5, height: 5, borderRadius: 2.5 },
    marker: { position: "absolute", left: -18, top: 0, width: 14, textAlign: "right", fontSize: 14, lineHeight: 20 },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      backgroundColor: colors.surface2,
    },
    cardText: { flex: 1, minWidth: 0 },
    cardTitle: { fontSize: 13, lineHeight: 18, fontWeight: "600", color: colors.text },
    cardFolder: { fontSize: 11.5, lineHeight: 15, color: colors.muted },
    cardOpen: { fontSize: 12, fontWeight: "600", color: colors.accentText },
  });
