import { StyleSheet } from "react-native";
import { layout, pointerType as t, radii, space } from "../../../design/tokens";
import type { Colors, Shadows } from "../../../design/theme";

/** One foot line: 5pt padding either side of a `treeMeta` line, and its rule. */
export const AGENTS_LINE_HEIGHT = 28;

/**
 * How far above the column's bottom edge the activity popover stands: the
 * account button at the foot, then the one-line activity row it opens from.
 */
export const ACTIVITY_LIFT = layout.accountFootHeight + 33;

export const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  explorer: { flex: 1, minHeight: 0 },

  /**
   * The column's header, and one row at every moment.
   *
   * Fixed height, so the row is the same size whether it carries the word
   * `Notes` or the filter field: the tree under it never moves when somebody
   * opens or closes the filter.
   */
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28 + space.x2 * 2,
    paddingHorizontal: space.x2,
  },
  /** `Notes`, inset to where a field's first character would sit. */
  label: { flex: 1, minWidth: 0, paddingLeft: space.x2 },
  /** The filter, once somebody has asked for it. Always boxed: it is a field. */
  filter: {
    flex: 1,
    minWidth: 0,
    height: 28,
    paddingHorizontal: space.x2,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    color: colors.text,
    fontSize: t.meta,
  },
  tools: { flexDirection: "row", alignItems: "center", gap: 6 },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  iconButtonHover: { borderColor: colors.lineStrong },
  /** A button whose menu is open, or the magnifier while a filter is on. */
  iconButtonOn: { borderColor: colors.lineStrong, backgroundColor: colors.surface3 },

  scroll: { flex: 1, minHeight: 0 },
  /**
   * `flexGrow` so the background filler below the rows can take the rest of
   * the column. Without it the content container is exactly as tall as its
   * rows and the filler is zero-height — which is a right-click target that
   * exists in the tree and not on the screen.
   */
  scrollContent: { paddingVertical: space.x2, paddingHorizontal: 6, flexGrow: 1 },
  /** See the filler's own comment in the render. */
  background: { flexGrow: 1 },
  status: { paddingHorizontal: space.x2, paddingVertical: space.x2 },

  match: {
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 1,
    width: "100%",
    paddingVertical: 5,
    paddingHorizontal: 8,
    borderRadius: radii.sm,
  },
  matchHover: { backgroundColor: colors.surface3 },
  matchOn: { backgroundColor: colors.accentDim },
  matchDetail: { opacity: 0.85 },

  refusal: {
    marginHorizontal: space.x2,
    marginBottom: space.x2,
    paddingVertical: space.x2,
    paddingHorizontal: space.x3,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warnBorder,
    backgroundColor: colors.warnWash,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.x2,
  },
  refusalText: { flex: 1, color: colors.warnText },
  refusalDismiss: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radii.sm },

  /** A 26pt strip under the column, carrying the one counts line. */
  foot: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: space.x3,
    paddingVertical: 5,
    gap: space.x2,
  },
  /** The same box, as a control: a row rather than a stack of one. */
  footPress: { flexDirection: "row", alignItems: "center" },
  footGrow: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  /** The one spot of petrol in the column, and only while something is new. */
  activityDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  /**
   * The list, floating over the tree and anchored to the line that opened it.
   *
   * Inset from the column's edges and shadowed rather than bordered, the way
   * every other floating surface in this product is drawn
   * (`4-resources/design/floating-chrome.md`). Capped at 60% of the column so
   * it never becomes the column: what is under it is the thing it is about.
   */
  activitySheet: {
    position: "absolute",
    left: space.x2,
    right: space.x2,
    bottom: ACTIVITY_LIFT,
    maxHeight: "60%",
    borderRadius: radii.panel,
    backgroundColor: colors.surface3,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    overflow: "hidden",
    boxShadow: shadows.floating,
  },
  activityScroll: { flexGrow: 0, flexShrink: 1 },
  activityFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x3,
    paddingVertical: space.x2,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
