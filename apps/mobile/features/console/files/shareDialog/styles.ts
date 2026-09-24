import { StyleSheet } from "react-native";
import { fonts, leading, pointerType, radii, touchType } from "../../../design/tokens";
import type { Colors } from "../../../design/theme";

/**
 * One sheet of styles for every part of the share dialog.
 *
 * The dialog follows the shape people already know from Google Docs: a title,
 * one field, a list of people, one line for general access, and Copy link
 * beside Done. Everything here is drawn from the Paper tokens — no colour is
 * named that `theme` does not already own, and hue is rationed the way the
 * palette asks: petrol for the one thing that is live (the public link's
 * tile, focus, a checked item), iris for a group, rust for the two acts that
 * take something away.
 *
 * `compact` is the phone. The phone is not this dialog shrunk: its text is
 * `touchType`, its menus are sheets from the bottom edge, and its footer
 * buttons split the width between them.
 */
export const makeStyles = (colors: Colors) => StyleSheet.create({
  /* ------------------------------- frame -------------------------------- */
  scrim: {
    flex: 1,
    backgroundColor: colors.scrim,
    alignItems: "center",
    justifyContent: "flex-start",
    /*
      Pinned from the top rather than centred (the top offset is set from the
      window height where the card is drawn). A centred card moves every time
      a row is added or a confirmation opens, and the field the person is
      typing into jumps with it.
    */
    paddingHorizontal: 20,
  },
  scrimSheet: { justifyContent: "flex-end", paddingTop: 0, paddingHorizontal: 0 },
  card: {
    width: "100%",
    maxWidth: 520,
    borderRadius: radii.card + 2,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    boxShadow: "0 30px 70px -24px rgba(26,23,20,.40)",
  },
  sheet: {
    maxWidth: undefined,
    borderRadius: 0,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    borderWidth: 0,
    paddingTop: 8,
  },
  handle: {
    width: 36,
    height: 4,
    alignSelf: "center",
    marginBottom: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.lineStrong,
  },
  body: { maxHeight: 560 },
  bodyContent: { gap: 22, paddingHorizontal: 24, paddingTop: 22, paddingBottom: 8 },
  bodyContentCompact: { paddingHorizontal: 16, paddingTop: 12 },

  /* ------------------------------- header ------------------------------- */
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  title: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    fontFamily: fonts.display,
    fontSize: pointerType.h3,
    lineHeight: leading(pointerType.h3, 1.3),
    fontWeight: "600",
    color: colors.text,
  },
  titleCompact: { fontSize: touchType.h3, lineHeight: leading(touchType.h3, 1.3) },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: radii.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonOn: { backgroundColor: colors.surface3 },

  /* -------------------------------- field ------------------------------- */
  field: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: radii.lg + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  fieldCompact: { minHeight: 48 },
  fieldFocused: {
    borderColor: colors.accent,
    boxShadow: `0 0 0 3px ${colors.accentDim}`,
  },
  input: {
    flexGrow: 1,
    flexShrink: 1,
    /*
      Flexbox gives a form control `min-width: auto`, so `flexShrink` alone
      does not let it go below its intrinsic width.
    */
    minWidth: 80,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: pointerType.lede,
    paddingVertical: 6,
    outlineStyle: "none" as never,
  },
  inputCompact: { fontSize: touchType.ui },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingLeft: 3,
    paddingRight: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.surface3,
  },
  chipText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "500", color: colors.text },
  pickedRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: -10 },
  pickedNote: { flexGrow: 1, flexShrink: 1, color: colors.muted },

  /* ----------------------------- suggestions ---------------------------- */
  suggestions: {
    marginTop: -12,
    padding: 6,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    boxShadow: "0 16px 40px -18px rgba(26,23,20,.30)",
  },
  suggestion: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: radii.md,
  },
  suggestionHover: { backgroundColor: colors.surface2 },
  suggestionReaching: { opacity: 0.55 },
  hasAccess: { color: colors.muted },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 5, marginHorizontal: 4 },

  /* ------------------------------ sections ------------------------------ */
  section: { gap: 4 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 4,
  },
  sectionTitle: {
    fontFamily: fonts.body,
    fontSize: pointerType.ui,
    lineHeight: leading(pointerType.ui, 1.4),
    fontWeight: "600",
    color: colors.text2,
  },
  sectionTitleCompact: { fontSize: pointerType.lede },

  /* -------------------------------- rows -------------------------------- */
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48 },
  rowCompact: { minHeight: 54 },
  rowTop: { alignItems: "flex-start", paddingTop: 4 },
  rowMain: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
  name: {
    fontFamily: fonts.body,
    fontSize: pointerType.ui,
    lineHeight: leading(pointerType.ui, 1.45),
    fontWeight: "500",
    color: colors.text,
  },
  nameCompact: { fontSize: touchType.ui },
  meta: { color: colors.muted },
  metaCompact: { fontSize: pointerType.ui },
  role: { fontFamily: fonts.body, fontSize: pointerType.ui, color: colors.muted },
  roleCompact: { fontSize: pointerType.lede },
  link: { color: colors.accent, fontWeight: "500" },

  avatar: {
    width: 32,
    height: 32,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.well,
  },
  avatarCompact: { width: 36, height: 36 },
  avatarSmall: { width: 22, height: 22 },
  avatarGroup: { backgroundColor: colors.sharedWash },
  avatarOwner: { backgroundColor: colors.warnWash },
  avatarText: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", color: colors.text2 },
  avatarTextSmall: { fontSize: pointerType.label },

  dropdown: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 5,
    paddingLeft: 10,
    paddingRight: 6,
    borderRadius: radii.md,
  },
  dropdownOpen: { backgroundColor: colors.surface3 },
  dropdownText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "500", color: colors.text2 },

  /* --------------------------- general access --------------------------- */
  tile: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface3,
  },
  tileCompact: { width: 40, height: 40 },
  tileLive: { backgroundColor: colors.accentDim },
  audienceTrigger: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginLeft: -6,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: radii.md,
  },
  audienceLabel: {
    fontFamily: fonts.body,
    fontSize: pointerType.ui,
    lineHeight: leading(pointerType.ui, 1.4),
    fontWeight: "600",
    color: colors.text,
  },
  audienceLabelCompact: { fontSize: touchType.ui },
  tag: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  indent: { marginLeft: 48 },
  indentCompact: { marginLeft: 52 },
  subList: { marginTop: 6, borderTopWidth: 1, borderTopColor: colors.line },
  subRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  subRowLast: { borderBottomWidth: 0 },
  confirm: {
    marginTop: 10,
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radii.lg + 2,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  confirmText: { color: colors.text2 },
  confirmActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },

  /* ------------------------------ short link ---------------------------- */
  shortLinkField: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
    paddingLeft: 10,
  },
  shortLinkInput: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 40,
    paddingVertical: 7,
    paddingRight: 10,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: pointerType.meta,
    outlineStyle: "none" as never,
  },

  /* -------------------------------- maker ------------------------------- */
  maker: {
    gap: 10,
    padding: 12,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  makerRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  makerInput: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: fonts.body,
    fontSize: pointerType.ui,
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  pickList: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  pick: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  pickOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  danger: { color: colors.critText },

  /* -------------------------------- footer ------------------------------ */
  problem: { paddingHorizontal: 24, paddingTop: 4, color: colors.critText },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 18,
  },
  footCompact: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 34 },
  footButton: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 16,
    borderRadius: radii.lg + 2,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface,
  },
  footButtonCompact: { flexGrow: 1, flexBasis: 0, height: 48 },
  footPrimary: { borderColor: colors.text, backgroundColor: colors.text, paddingHorizontal: 20 },
  footLabel: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text },
  footLabelCompact: { fontSize: touchType.ui },
  footPrimaryLabel: { color: colors.surface },
  smallButton: { height: 30, paddingHorizontal: 12 },
  ghostButton: { borderColor: "transparent", backgroundColor: "transparent" },
});
