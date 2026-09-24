import { StyleSheet } from "react-native";
import { fonts, layout, leading, pointerType as t, radii, space } from "../../../design/tokens";
import type { Colors } from "../../../design/theme";

/**
 * One stylesheet for the note surface and every piece of it, so the pieces
 * `NoteEditor` is drawn from share one `makeStyles` rather than each holding
 * a copy.
 */
export const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: 12, flex: 1, minHeight: 0 },
  /** The document runs to the edges; what padding there is belongs to it. */
  wrapCompact: { gap: 0 },

  /** The phone's scroll surface: full height, padded in its content. */
  scroll: { flex: 1, minHeight: 0 },

  /**
   * Obsidian's inline title.
   *
   * 28 on a 34 line box, measured off the reference at 440pt: the name sits a
   * clear step above the note's own `# Heading` without becoming a masthead,
   * and it is the first ink on the page rather than a caption over it. The
   * negative tracking is what a bold face at this size needs to stop reading as
   * spaced-out; the side margin is `readingMargin`, the one number every band
   * that lines up with the first character of the note shares.
   *
   * `marginBottom` rather than a gap on the parent: the next thing down is
   * either the Properties card or the editor, and both bring their own top
   * space — one number here is easier to reason about than a gap that applies
   * between every pair.
   */
  inlineTitle: {
    paddingHorizontal: layout.readingMargin,
    // 20 above, measured: the reference leaves about 33pt between the bottom of
    // the floating toggle and the top of the title's line box, and
    // `contentInsets.top` already carries 12 of it.
    marginTop: space.x5,
    marginBottom: space.x1,
    fontSize: t.title,
    lineHeight: leading(t.title, 1.21),
    fontWeight: "700",
    letterSpacing: -0.5,
    color: colors.text,
  },

  /**
   * The Properties row and the editor under it, as one column.
   *
   * `flex: 1` with `minHeight: 0` so the editor keeps scrolling itself and the
   * row above it keeps its own height rather than being compressed out of
   * existence by a `flex: 1` sibling.
   */
  document: { flex: 1, minHeight: 0 },

  /**
   * A quiet line above the note, at the note's own left margin.
   *
   * `readingMargin` rather than a number of its own: this sits directly above
   * the first line of the document and anything else here would be visibly out
   * of step with it.
   */
  /**
   * A quiet line above the note, at the note's own left margin.
   *
   * The margin arrives as a prop rather than being set here, because on a
   * pointer layout it is not a constant: the note is a centred column and its
   * first character moves with the width. See `noteGutterFor`.
   */
  properties: {
    paddingTop: space.x1,
    paddingBottom: space.x2,
  },
  /**
   * The panel, as the reference draws it.
   *
   * A tinted rounded card rather than a bare list, which is the whole of what
   * makes it read as metadata *about* the note instead of as the note's first
   * paragraph. `radii.sheet` because this is a grouped card on a phone and that
   * is what the phone geometry in `tokens.ts` is for; `surface2` because the
   * ground is paper now and a card on paper separates by being a shade off it.
   *
   * The negative margin pulls it back out to the reference's own inset, which
   * is wider than the note's text column — Obsidian's card is not aligned to
   * its prose either, and a card indented to the text measure reads as part of
   * the text.
   */
  propertyCard: {
    marginTop: space.x1,
    marginHorizontal: -(layout.readingMargin - space.x4),
    paddingVertical: 6,
    borderRadius: radii.sheet,
    backgroundColor: colors.surface2,
  },
  propertiesHead: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    minHeight: 24,
    paddingRight: space.x2,
    borderRadius: radii.sm,
  },
  /** A thumb's floor, which a pointer does not pay — see the `compact` prop. */
  propertiesHeadTouch: { minHeight: layout.minTouchTarget },
  propertiesHover: { backgroundColor: colors.surface3 },
  /**
   * One row: mark, key, value.
   *
   * A two-column grid is what this wants and what React Native does not have;
   * a fixed leading column is the honest approximation, and the keys in a
   * captured note (`sender-domain`, `authentication-result`) are long enough
   * that a shrink-to-fit column would be a different width on every note — so
   * the values would not line up down the card, which is the one thing a
   * two-column layout exists to do.
   *
   * `alignItems: "flex-start"` because a long value wraps: the mark and the key
   * stay on the first line rather than centring against a three-line value.
   */
  property: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.x2,
    minHeight: 36,
    paddingVertical: 5,
    paddingHorizontal: space.x4,
  },
  propertyMark: { width: 18, alignItems: "center", paddingTop: 4 },
  /**
   * 15 on a 22 line box, not the 12.5 a `treeMeta` row would be.
   *
   * These are values somebody reads — a captured note's subject, a sender, a
   * timestamp — and the reference sets them at reading size. Metadata type is
   * for the counts under a tree, where the number is a glance rather than a
   * sentence.
   */
  propertyKey: {
    width: 96,
    flexGrow: 0,
    flexShrink: 0,
    fontSize: t.lede,
    lineHeight: 22,
    color: colors.muted,
  },
  propertyValue: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: t.lede,
    lineHeight: 22,
    color: colors.text,
  },
  /** Dimmed rather than absent — see the call site for why it is here at all. */
  propertyAdd: { opacity: 0.55 },
  propertyAddLabel: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontSize: t.lede,
    lineHeight: 22,
    color: colors.muted,
  },

  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  /**
   * The last line of the document, not a strip under it.
   *
   * It used to carry `colors.surface`, and that fill was load-bearing while
   * this was pinned below a `flex: 1` editor that clipped: without it the row
   * sat against a line of text cut off mid-height and the two read as one thing
   * overlapping. Nothing clips now — the whole note is one scroller and this
   * scrolls inside it — so a painted band here would be the bar this is
   * deliberately not.
   *
   * `readingMargin` because it lines up with the first character of the note,
   * like every other band that has to.
   */
  statusRowCompact: {
    paddingHorizontal: layout.readingMargin,
    paddingTop: space.x4,
    paddingBottom: space.x2,
  },
  status: { flexGrow: 1, flexShrink: 1 },

  presenceRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 6 },
  conflict: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnWash,
    gap: 10,
  },
  conflictText: { color: colors.warnText },
  conflictActions: { flexDirection: "row", gap: 10 },

  notice: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    backgroundColor: colors.hintWash,
    borderWidth: 1,
    borderColor: colors.hintBorder,
  },
  noticeStrong: { color: colors.hintStrong, fontFamily: fonts.mono },
});

export type NoteEditorStyles = ReturnType<typeof makeStyles>;
