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

import { createContext, useContext, type ReactNode } from "react";
import { Linking, Text as RNText, StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { fonts, leading, pointerType as t, radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import type { Block, Inline } from "./markdown";
import { SITE_HEADING_SIZE, SITE_WIDE_HEADING_SIZE, makeSiteStyles, makeSiteWideStyles } from "./siteLook";

/**
 * Which voice the document is drawn in: `note` for a shared note, `site` for a
 * page on a published website — larger body type and serif headings, the one
 * face the public site adds. Same blocks, same safety rules; only styles differ.
 */
/** `siteWide` is the site look on a desktop-width screen. */
export type NoteLook = "note" | "site" | "siteWide";

const Look = createContext<NoteLook>("note");

/**
 * Where a link to a page on the same site goes — see `sitePathHref`. Only the
 * website page supplies one; without it such a link is drawn as its words.
 */
const SiteLink = createContext<((href: string) => void) | null>(null);

function useBodyStyles() {
  const note = useThemedStyles(makeStyles);
  const site = useThemedStyles(makeSiteStyles);
  const wide = useThemedStyles(makeSiteWideStyles);
  const look = useContext(Look);
  if (look === "note") return note;
  return look === "site" ? { ...note, ...site } : { ...note, ...site, ...wide };
}

/**
 * `renderCode` — the one place this renderer hands a block to somebody else.
 *
 * It exists for the form fence, which a *collect* link draws as a form you can
 * fill in rather than as the block's source. Deliberately a hook and not a
 * `case "form"` here: this file's rule is that nothing in it can turn a string
 * into markup, and that stays true when the only escape hatch is a function
 * the caller passed in, for one block kind, returning `null` to fall through
 * to the ordinary code block.
 *
 * Every caller that does not pass one renders exactly what it rendered before.
 */
export function NoteBody({
  blocks,
  renderCode,
  look = "note",
  onSiteLink,
}: {
  blocks: readonly Block[];
  renderCode?: (block: { text: string; language?: string }) => ReactNode | null;
  look?: NoteLook;
  onSiteLink?: (href: string) => void;
}) {
  return (
    <Look.Provider value={look}>
      <SiteLink.Provider value={onSiteLink ?? null}>
        <Blocks blocks={blocks} renderCode={renderCode} />
      </SiteLink.Provider>
    </Look.Provider>
  );
}

function Blocks({
  blocks,
  renderCode,
}: {
  blocks: readonly Block[];
  renderCode?: (block: { text: string; language?: string }) => ReactNode | null;
}) {
  const styles = useBodyStyles();
  return (
    <View style={styles.body}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} renderCode={renderCode} />
      ))}
    </View>
  );
}

function BlockView({
  block,
  renderCode,
}: {
  block: Block;
  renderCode?: (block: { text: string; language?: string }) => ReactNode | null;
}) {
  const styles = useBodyStyles();
  const look = useContext(Look);
  if (block.kind === "code" && renderCode !== undefined) {
    const replaced = renderCode(block);
    if (replaced !== null && replaced !== undefined) return <>{replaced}</>;
  }
  switch (block.kind) {
    case "heading":
      return (
        <Text
          variant="paneTitle"
          role="heading"
          aria-level={block.level}
          style={[styles.heading, headingStyle(block.level, look)]}
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

/*
 * Runs are bare `Text`, not the body variant: a nested variant carries its own
 * size and face, which pinned every run in a heading to body size — a heading
 * of plain words drew at 16 whatever its level. Bare, a run inherits the
 * block's type and adds only its own emphasis.
 */
function Runs({ runs }: { runs: readonly Inline[] }) {
  const styles = useBodyStyles();
  const siteLink = useContext(SiteLink);
  return (
    <>
      {runs.map((run, index) => {
        switch (run.kind) {
          case "strong":
            return (
              <RNText key={index} style={styles.strong}>
                {run.text}
              </RNText>
            );
          case "em":
            return (
              <RNText key={index} style={styles.em}>
                {run.text}
              </RNText>
            );
          case "strike":
            return (
              <RNText key={index} style={styles.strike}>
                {run.text}
              </RNText>
            );
          case "code":
            return (
              <RNText key={index} style={styles.inlineCode}>
                {run.text}
              </RNText>
            );
          case "link": {
            const onPage = run.href.startsWith("/");
            if (onPage && siteLink === null) {
              return <RNText key={index}>{run.text}</RNText>;
            }
            return (
              <RNText
                key={index}
                style={styles.link}
                accessibilityRole="link"
                // `openURL` rather than an anchor: the href was vetted by
                // `safeHref`, and the platform still gets the final say about
                // whether it can open it.
                onPress={() => {
                  if (onPage) siteLink?.(run.href);
                  else void Linking.openURL(run.href).catch(() => {});
                }}
              >
                {run.text}
              </RNText>
            );
          }
          default:
            return (
              <RNText key={index}>
                {run.text}
              </RNText>
            );
        }
      })}
    </>
  );
}

/**
 * Sizes only; the face and colour come from `paneTitle`.
 *
 * Six roles for six levels, and they have to stay six: `h5` and `h6` were
 * 13.5 and 13 before this drew from the scale, which is a distinction no
 * reader could see but which the renderer still owed the document. Mapping
 * both to `ui` would have collapsed a level silently, so `h6` takes `meta` —
 * the ladder is 23 / 19 / 16 / 15 / 13 / 12 and every step is visible.
 */
const HEADING_SIZE = StyleSheet.create({
  h1: { fontSize: t.h2, lineHeight: leading(t.h2, 1.25), marginTop: 6 },
  h2: { fontSize: t.h3, lineHeight: leading(t.h3, 1.3), marginTop: 20 },
  h3: { fontSize: t.body, lineHeight: leading(t.body, 1.35), marginTop: 16 },
  h4: { fontSize: t.lede, lineHeight: leading(t.lede, 1.4), marginTop: 14 },
  h5: { fontSize: t.ui, lineHeight: leading(t.ui, 1.4), marginTop: 12 },
  h6: { fontSize: t.meta, lineHeight: leading(t.meta, 1.4), marginTop: 12 },
});

/**
 * Keyed `h1`…`h6`, not `1`…`6`.
 *
 * `StyleSheet.create` with numeric keys hands back numeric ids that a lookup
 * by `block.level` silently misses — so every heading rendered at the same
 * size. Invisible to a test that asserts on the parsed level; obvious in a
 * screenshot.
 */
const headingStyle = (level: 1 | 2 | 3 | 4 | 5 | 6, look: NoteLook) =>
  (look === "site" ? SITE_HEADING_SIZE : look === "siteWide" ? SITE_WIDE_HEADING_SIZE : HEADING_SIZE)[
    `h${level}` as const
  ];

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  codeText: { color: colors.text2, fontFamily: fonts.mono, fontSize: t.meta },
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
    fontSize: t.ui,
  },
  headCell: { color: colors.text, fontWeight: "600" },
  strong: { color: colors.text, fontWeight: "600" },
  em: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through", color: colors.muted },
  inlineCode: {
    fontFamily: fonts.mono,
    fontSize: t.meta,
    color: colors.text,
  },
  link: { color: colors.codeKey, textDecorationLine: "underline" },
});
