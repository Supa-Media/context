/**
 * A shared note, drawn as a document.
 *
 * Takes the blocks `markdown.ts` produced and renders them with React Native
 * primitives — `Text` and `View`, nothing that interprets markup. That is the
 * point rather than a limitation: this is **somebody else's note**, and the
 * parser has already decided what each run of text is. Nothing here can turn a
 * string into markup, because nothing here is given the chance to.
 *
 * Links are the one interactive element, and `safeHref` has already rejected
 * every scheme but http(s), mailto and tel. A rejected one arrived as plain
 * text and is not tappable at all.
 */

import { Linking, StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { colors, fonts, leading, radii } from "../design/tokens";
import type { Block, Inline } from "./markdown";

export function NoteBody({ blocks }: { blocks: readonly Block[] }) {
  return (
    <View style={styles.body}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </View>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "heading":
      return (
        <Text
          variant="paneTitle"
          role="heading"
          aria-level={block.level}
          style={[styles.heading, headingStyle(block.level)]}
        >
          <Runs runs={block.content} />
        </Text>
      );

    case "paragraph":
      return (
        <Text variant="body" style={styles.paragraph}>
          <Runs runs={block.content} />
        </Text>
      );

    case "bullet":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.item}>
              <Text variant="body" style={styles.marker}>
                •
              </Text>
              <Text variant="body" style={styles.itemText}>
                <Runs runs={item} />
              </Text>
            </View>
          ))}
        </View>
      );

    case "ordered":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            <View key={index} style={styles.item}>
              <Text variant="body" style={styles.marker}>
                {index + 1}.
              </Text>
              <Text variant="body" style={styles.itemText}>
                <Runs runs={item} />
              </Text>
            </View>
          ))}
        </View>
      );

    case "quote":
      return (
        <View style={styles.quote}>
          <Text variant="body" style={styles.quoteText}>
            <Runs runs={block.content} />
          </Text>
        </View>
      );

    case "code":
      return (
        <View style={styles.code}>
          {/* `selectable` because a shared note's code is usually the reason
              it was shared, and a reader who cannot copy it has to retype it. */}
          <Text variant="code" selectable style={styles.codeText}>
            {block.text}
          </Text>
        </View>
      );

    case "rule":
      return <View style={styles.rule} />;

    case "table":
      return (
        <View style={styles.table}>
          <View style={[styles.row, styles.headRow]}>
            {block.header.map((cell, index) => (
              <Text key={index} variant="body" style={[styles.cell, styles.headCell]}>
                <Runs runs={cell} />
              </Text>
            ))}
          </View>
          {block.rows.map((row, rowIndex) => (
            <View key={rowIndex} style={styles.row}>
              {row.map((cell, index) => (
                <Text key={index} variant="body" style={styles.cell}>
                  <Runs runs={cell} />
                </Text>
              ))}
            </View>
          ))}
        </View>
      );
  }
}

function Runs({ runs }: { runs: readonly Inline[] }) {
  return (
    <>
      {runs.map((run, index) => {
        switch (run.kind) {
          case "strong":
            return (
              <Text key={index} variant="body" style={styles.strong}>
                {run.text}
              </Text>
            );
          case "em":
            return (
              <Text key={index} variant="body" style={styles.em}>
                {run.text}
              </Text>
            );
          case "strike":
            return (
              <Text key={index} variant="body" style={styles.strike}>
                {run.text}
              </Text>
            );
          case "code":
            return (
              <Text key={index} variant="body" style={styles.inlineCode}>
                {run.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={index}
                variant="body"
                style={styles.link}
                accessibilityRole="link"
                // `openURL` rather than an anchor: the href was vetted by
                // `safeHref`, and the platform still gets the final say about
                // whether it can open it.
                onPress={() => {
                  void Linking.openURL(run.href).catch(() => {});
                }}
              >
                {run.text}
              </Text>
            );
          default:
            return (
              <Text key={index} variant="body">
                {run.text}
              </Text>
            );
        }
      })}
    </>
  );
}

/** Sizes only; the face and colour come from `paneTitle`. */
const HEADING_SIZE = StyleSheet.create({
  h1: { fontSize: 26, lineHeight: leading(26, 1.25), marginTop: 6 },
  h2: { fontSize: 20, lineHeight: leading(20, 1.3), marginTop: 20 },
  h3: { fontSize: 16.5, lineHeight: leading(16.5, 1.35), marginTop: 16 },
  h4: { fontSize: 14.5, lineHeight: leading(14.5, 1.4), marginTop: 14 },
  h5: { fontSize: 13.5, lineHeight: leading(13.5, 1.4), marginTop: 12 },
  h6: { fontSize: 13, lineHeight: leading(13, 1.4), marginTop: 12 },
});

/**
 * Keyed `h1`…`h6`, not `1`…`6`.
 *
 * `StyleSheet.create` with numeric keys hands back numeric ids that a lookup
 * by `block.level` silently misses — so every heading rendered at the same
 * size. Invisible to a test that asserts on the parsed level; obvious in a
 * screenshot.
 */
const headingStyle = (level: 1 | 2 | 3 | 4 | 5 | 6) => HEADING_SIZE[`h${level}` as const];

const styles = StyleSheet.create({
  body: { gap: 12 },
  heading: { color: colors.text },
  paragraph: { color: colors.text2, lineHeight: leading(14.5, 1.75) },
  list: { gap: 6, paddingLeft: 4 },
  item: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  marker: { color: colors.muted, minWidth: 18 },
  itemText: { flexGrow: 1, flexShrink: 1, color: colors.text2, lineHeight: leading(14.5, 1.7) },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.line,
    paddingLeft: 14,
    paddingVertical: 2,
  },
  quoteText: { color: colors.muted, fontStyle: "italic" },
  code: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  codeText: { color: colors.text2, fontFamily: fonts.mono, fontSize: 12.5 },
  rule: { height: 1, backgroundColor: colors.line, marginVertical: 8 },
  table: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    overflow: "hidden",
  },
  row: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.line },
  headRow: { borderTopWidth: 0, backgroundColor: colors.well },
  cell: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    paddingVertical: 9,
    paddingHorizontal: 12,
    color: colors.text2,
    fontSize: 13,
  },
  headCell: { color: colors.text, fontWeight: "600" },
  strong: { color: colors.text, fontWeight: "600" },
  em: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through", color: colors.muted },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    color: colors.text,
  },
  link: { color: colors.codeKey, textDecorationLine: "underline" },
});
