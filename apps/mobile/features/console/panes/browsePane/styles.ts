import { StyleSheet } from "react-native";
import { layout, radii, space } from "../../../design/tokens";
import type { Colors } from "../../../design/theme";

/** Shared by every part of the Browse pane, so they all draw from one sheet of styles. */
export const makeStyles = (colors: Colors) => StyleSheet.create({
  /** The editor region: chrome on its top edge, the document filling the rest. */
  region: { flex: 1, minHeight: 0 },
  /**
   * The breadcrumb takes the room it needs; Share sits at the end of the line.
   *
   * **The row reserves its own height, and that is the whole fix for an
   * overlap that looked like a stacking bug.** Share was drawing on top of the
   * note's name, and the cause was not z-index: this row had no vertical
   * padding, `Breadcrumb.barCompact` zeroed its own `paddingTop`, and `Button`
   * brings `paddingVertical: 6`. So the row's height was the crumb's line box —
   * shorter than the button inside it — and the button overflowed in both
   * directions onto whatever was drawn next. A row that is at least as tall as
   * the tallest thing in it cannot overlap anything.
   *
   * `minHeight` rather than a fixed height: the crumb is one line today and a
   * longer context name is one word from being two.
   */
  noteHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    minHeight: layout.minTouchTarget,
    /*
      Share does not sit on the edge of the window.

      This padding used to be here as `noteHeadCompact`, applied by
      `compact && styles.noteHeadCompact` — on a row whose only render site is
      gated on `!compact`. So the one density that draws it got none, and
      Share's 30pt target ended flush against the region's trailing edge with
      the glyph's own 6pt inset the only air around it. The owner's report was
      that it sits "a little too close to the edge", which is the condition the
      dead style was written to prevent.

      The row still keeps its actions at the trailing edge — that is the design,
      and the header above says so — so this is a gutter rather than a move
      inwards. `space.x2` and not `layout.readingMargin`: the crumb's reading
      gutter is the note's left margin and pulling Share in by the same 25pt
      would read as the actions having left the edge.
    */
    paddingRight: space.x2,
  },
  /**
   * The breadcrumb yields first.
   *
   * `flexShrink: 1` with `minWidth: 0` is what lets the path ellipsise. The
   * actions beside it never give: React Native's `flexShrink` defaults to `0`,
   * so a `FrameIconButton` holds its target while the path ellipsises around
   * it. They used to carry `flexShrink: 0` explicitly because they were word
   * buttons, and a long path squeezed "Share…" to "Sha…" — a control nobody
   * presses on the theory that it might do something else. A glyph cannot be
   * truncated into a different glyph, so that failure went with the words
   * rather than being guarded against.
   */
  crumb: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0, padding: space.x4 },
  /**
   * The pointer layout's page scroller, and its content.
   *
   * `body`'s padding without `body`: the box fills the region and the padding
   * goes on what scrolls inside it, so the scrollbar rides the edge of the pane
   * rather than being inset 16pt from it. `flexGrow: 1` rather than `flex: 1`,
   * because a flex child of a content container has nothing to fill — the same
   * distinction `bodyCompact` records — and what is wanted here is a floor, not
   * a cap: the page is at least the region tall and longer when its content is.
   */
  page: { flex: 1, minHeight: 0 },
  pageContent: { flexGrow: 1, padding: space.x4 },
  /**
   * The phone's page scroller: full-bleed, with the chrome paid for in content
   * padding at the call site rather than in a shorter viewport here.
   */
  /**
   * The listing's scroller, and its ground.
   *
   * `chromeSurface`, because this branch is the phone's **folder** screen and a
   * listing is not a document — it is the furniture you pick a document from.
   * `Phone-Browse.dc.html` grounds it a step down from the cards on it, which
   * is the whole reason those cards read as cards; `Phone-Note.dc.html` leaves
   * the note on the page surface, because a note IS the page.
   *
   * On the scroller rather than on `FolderView`'s own container, which was
   * where it went first: that view sits inside this scroller's content, which
   * does not stretch its children, so the ground stopped where the rows did and
   * left a visible seam across the middle of the screen with the page surface
   * below it. Measured in a browser — nothing in the suite can see a band that
   * ends early.
   */
  scroll: { flex: 1, minHeight: 0, backgroundColor: colors.chromeSurface },
  /**
   * No padding, and no `flex: 1`.
   *
   * The document runs to the edges of the glass and what padding there is
   * belongs to it. `flex` is gone because this now sits inside a scroller's
   * content, where a flex child of a `contentContainer` has nothing to fill and
   * would collapse a folder listing to nothing.
   */
  bodyCompact: { padding: 0 },

  notices: { paddingHorizontal: space.x4, paddingTop: space.x3, gap: space.x2 },
  noticesCompact: { paddingHorizontal: layout.readingMargin, paddingTop: space.x2 },
  notice: {
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    backgroundColor: colors.hintWash,
    gap: 10,
  },
  noticeWarn: { borderColor: colors.warnBorder, backgroundColor: colors.warnWash },
  noticeWarnText: { color: colors.warnText },
  dismiss: { alignSelf: "flex-start" },
  /**
   * Two buttons under a notice rather than one.
   *
   * `dismiss`'s `alignSelf` does the same job for a single control; a row
   * needs to wrap instead, because "Update Context storage" beside "Not now"
   * is wider than a 390pt phone's notice at its own padding.
   */
  noticeActions: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },

  empty: { padding: space.x6, gap: space.x2, maxWidth: 520 },
  emptyLine: { marginTop: 2 },
});
