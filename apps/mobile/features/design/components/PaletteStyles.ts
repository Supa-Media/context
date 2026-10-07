import { StyleSheet } from "react-native";
import { fonts, pointerType as t, radii, space, touchType } from "../tokens";
import type { Colors } from "../theme";
import { POINTER_ROW_HEIGHT } from "./PaletteRow";

/** Roughly nine rows before the pointer panel starts scrolling. */
const POINTER_LIST_MAX_HEIGHT = POINTER_ROW_HEIGHT * 9;

/** `Palette`'s styles, pointer panel and touch sheet. */
export const makeStyles = (colors: Colors) => StyleSheet.create({
  /* ------------------------------- pointer ------------------------------- */

  scrim: {
    flex: 1,
    backgroundColor: "rgba(3,3,4,.72)",
    alignItems: "center",
    paddingHorizontal: space.x6,
  },
  panel: {
    width: "100%",
    maxWidth: 560,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.card,
    backgroundColor: colors.surface3,
    overflow: "hidden",
    boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
  },
  panelHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x2,
    paddingHorizontal: space.x4,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },

  /* -------------------------------- input -------------------------------- */

  input: {
    flex: 1,
    fontFamily: fonts.body,
    color: colors.text,
    // The panel is the field; the browser's own focus ring drew a blue box inside it.
    outlineWidth: 0,
  },
  inputPointer: { fontSize: t.lede, paddingVertical: 13 },
  /**
   * 17, not 15. RN-Web renders this as a real `<input>`, and mobile Safari
   * zooms the whole page when one under 16px takes focus — a zoom the person
   * then has to pinch their way back out of, on the screen they opened to
   * find one note.
   */
  inputTouch: {
    fontSize: touchType.lede,
    paddingVertical: 11,
    paddingHorizontal: space.x2,
  },

  /* -------------------------------- list --------------------------------- */

  listPointer: { maxHeight: POINTER_LIST_MAX_HEIGHT },
  listTouch: { flex: 1 },
  listContent: { paddingVertical: space.x1 },
  heading: {
    paddingHorizontal: space.x4,
    paddingTop: space.x3,
    paddingBottom: space.x1,
  },
  empty: {
    paddingHorizontal: space.x4,
    paddingVertical: space.x5,
  },
  /**
   * Fixed above the scrolling list — see `reducedRecallNotice`'s own
   * comment for why this cannot live inside it. `lineStrong` on both edges
   * so it reads as its own strip rather than as part of whichever
   * neighbour happens to be empty this render.
   */
  notice: {
    paddingHorizontal: space.x4,
    paddingVertical: space.x2,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surface2,
  },
});
