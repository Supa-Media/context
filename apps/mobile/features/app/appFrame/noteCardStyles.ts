import { StyleSheet, type ViewStyle } from "react-native";
import { space } from "../../design/tokens";
import type { Colors } from "../../design/theme";

/** `styles.ts`'s `NO_DRAG_REGION`, here so this file does not import the file that spreads it. */
const NO_DRAG_REGION = { WebkitAppRegion: "no-drag" } as unknown as ViewStyle;

/** The note card's insets from the tree, the window's top and the panel, as the mock draws them. */
const CARD_LEFT = 8;
const CARD_TOP = 4;
const CARD_RIGHT = 6;

/** The frame's row with the right panel beside it, and the note card, spread into `makeStyles`. */
export const noteCardStyles = (colors: Colors) =>
  ({
  /** The bar and the body, then the right panel the frame's full height (`frameAsideColumn`). */
  frameRow: { flex: 1, minHeight: 0, flexDirection: "row" },
  frameMain: { flex: 1, minWidth: 0, minHeight: 0 },

  /*
    The note card (Dev2, 2026-11-20, the in-app Tex mock): the page is a card on the chrome, inset from the tree and
    the panel. Its outline is ONE line (Dev2, 2026-11-21: "a clean outline", not "ugly double lines"): the tabs sit on
    the chrome, the hairline under them is the card's top edge, and the tab in front rings itself and opens into the
    page, so the tab's ring and the card's sides are one continuous line. No second ring round the tabs.
    `topCard` is the tab row, in the bar; `editor` is the rest.
  */
  topCard: {
    alignSelf: "stretch",
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    marginTop: CARD_TOP,
    marginLeft: CARD_LEFT,
    marginRight: CARD_RIGHT - space.x3,
    paddingTop: 6,
    paddingHorizontal: space.x2,
    gap: space.x2,
    ...NO_DRAG_REGION,
  },
  /** The hairline under the tabs, drawn first so the tab in front covers it and opens into the page. */
  topCardRule: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
  },
  topCardFill: { flex: 1 },
  /** The rest of the note card under its top (`topCard`), at a pointer density. */
  editorCard: {
    marginLeft: CARD_LEFT,
    marginRight: CARD_RIGHT,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  }) as const;
