import { StyleSheet } from "react-native";
import { fonts, leading, pointerType as t, radii, touchType } from "../../../design/tokens";
import type { Colors } from "../../../design/theme";

/** Shared by every part of the share sheet, so they all draw from one sheet of styles. */
export const makeStyles = (colors: Colors) => StyleSheet.create({
  access: { gap: 8, marginBottom: 4 },
  audienceWrap: { gap: 6 },
  audience: {
    flexDirection: "row",
    gap: 4,
    padding: 3,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
  },
  segment: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: radii.md,
  },
  segmentOn: { backgroundColor: colors.surface },
  segmentText: { color: colors.muted },
  segmentTextOn: { color: colors.text },

  /* ---------------------------------------------------------------- *
   * The phone's grouped list. See `AudienceControl`.
   * ---------------------------------------------------------------- */
  positions: {
    borderRadius: radii.sheet,
    backgroundColor: colors.well,
    overflow: "hidden",
  },
  /*
    56, which is the row height this phone already uses for a grouped list and
    is comfortably past the 44 a thumb needs. The segmented control it replaces
    was 7pt of padding around an 11pt label.
  */
  position: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  /*
    Inset from the icon rather than from the card edge — the rule separates the
    rows' CONTENT, and a full-bleed one reads as the end of the card.
  */
  positionRuled: { borderTopWidth: 1, borderTopColor: colors.line, marginLeft: 16 },
  positionMain: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  /*
    `touchType.ui`, and the reason is `Text`'s own `railTouch`: this list is
    how the decision gets made on a phone, and a decision is read at the size
    the screen is read at rather than at a 216pt column's supporting-label
    size. The position not in force is dimmed rather than drawn smaller.
  */
  positionName: {
    fontFamily: fonts.body,
    fontSize: touchType.ui,
    lineHeight: leading(touchType.ui, 1.4),
    fontWeight: "500",
    color: colors.text,
  },
  positionNameOff: {
    fontFamily: fonts.body,
    fontSize: touchType.ui,
    lineHeight: leading(touchType.ui, 1.4),
    fontWeight: "500",
    color: colors.text2,
  },
  positionDetail: { color: colors.muted },
  confirm: {
    gap: 8,
    padding: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.critBorder,
    backgroundColor: colors.critWash,
  },
  accessRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    /*
      No `flexWrap`. It was harmless while the trailing slot was a one-word
      role, and wrong the moment it became a control: a long reason line
      pushed the button onto its own row, where it stretched full width and
      read as the sheet's primary action rather than as this person's.
      `accessMain` has `minWidth: 0`, so the text shrinks instead.
    */
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  accessMain: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  accessReason: { color: colors.muted },
  /* Row plus whatever it has expanded, so the divider stays on the row. */
  accessGroup: { gap: 0 },
  routes: {
    gap: 2,
    marginBottom: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    overflow: "hidden",
  },
  route: { paddingVertical: 9, paddingHorizontal: 10, gap: 1 },
  routeDanger: { color: colors.crit },
  linkRow: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  linkMain: { flexGrow: 1, flexShrink: 1, minWidth: 160, gap: 1 },
  linkNote: { color: colors.muted },
  shortLinkField: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 180,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    paddingLeft: 10,
  },
  shortLinkPrefix: { color: colors.muted },
  shortLinkInput: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 60,
    paddingVertical: 9,
    paddingRight: 10,
    color: colors.text,
  },
  shortLinkClaimed: { flexGrow: 1, flexShrink: 1, minWidth: 160, color: colors.accentText },
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  /** The sheet is at the bottom, and pays no gutter it would only waste. */
  scrimSheet: { justifyContent: "flex-end", padding: 0 },
  /**
   * The phone's sheet: full width, top corners only, and `radii.sheet` for
   * them — the token documented as "a grouped list card, and the drawer's
   * trailing corners", which is the family every other surface that comes up
   * from an edge on this phone already uses.
   */
  sheet: {
    maxWidth: undefined,
    borderRadius: 0,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    borderWidth: 0,
    paddingTop: 10,
    paddingBottom: 34,
  },
  /** The grab handle. Drawn, inert — see its use site. */
  handle: {
    width: 36,
    height: 4,
    alignSelf: "center",
    marginBottom: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.lineStrong,
  },
  card: {
    width: "100%",
    maxWidth: 560,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    padding: 20,
    gap: 14,
  },
  /*
    A scroll surface with a ceiling, so the sheet cannot grow past the screen.
    It used to be a plain `View`: with three prose sections, a shared-with list
    and an advanced block, the Done button left the bottom of a phone entirely.
  */
  body: { maxHeight: 460 },
  bodyContent: { gap: 16, paddingBottom: 4 },
  section: { gap: 8 },
  row: { flexDirection: "row", gap: 10, alignItems: "center" },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    /*
      Flexbox gives a form control `min-width: auto`, so `flexShrink` alone
      does not let it go below its intrinsic width — which pushed the group
      maker's Cancel button off the right edge of its own panel.
    */
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.lg,
    backgroundColor: colors.well,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: t.ui,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  list: { gap: 8 },
  listHead: { letterSpacing: 1, color: colors.muted },
  // Capped so a note shared with a dozen people does not push Done off screen.
  listScroll: { maxHeight: 260 },
  share: {
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
    marginBottom: 8,
  },
  shareTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  recipient: { flexGrow: 1, flexShrink: 1, color: colors.text },
  suggestions: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.md,
    overflow: "hidden",
  },
  suggestion: { paddingVertical: 8, paddingHorizontal: 10, gap: 2 },
  makeGroup: { paddingVertical: 2 },
  makeGroupText: { color: colors.accent },
  /* Wraps rather than clips: three controls on a 390pt phone, inside a panel. */
  makerRow: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  maker: {
    gap: 8,
    padding: 10,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.well,
  },
  pickList: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pick: {
    paddingVertical: 5,
    paddingHorizontal: 9,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  /* An answer rather than an offer: on the well, so it does not read as a button. */
  suggestionReaching: { backgroundColor: colors.well },
  suggestionMuted: { color: colors.text2 },
  suggestionDetail: { color: colors.muted },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  previewText: { flexGrow: 1, flexShrink: 1 },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
});
