/**
 * The `site` look of `NoteBody`: how a page reads on a published website.
 *
 * Overrides only — every key here replaces the note look's style of the same
 * name, so a block kind this file does not mention reads as it does in a
 * shared note. The sizes follow the approved public-site spec: body 18/1.65,
 * H1 44/1.1 and H2 26 in Instrument Serif, links in the text colour with a
 * muted underline, code on the chrome paper at radius 6.
 *
 * Runs (bold, links, inline code) inherit the block's size, so only blocks
 * set one here.
 */

import { StyleSheet } from "react-native";
import { fonts, leading, siteType } from "../design/tokens";
import type { Colors } from "../design/theme";
import { siteSerif } from "../site/siteFonts";

const BODY = siteType.body;
// `textWrap` is web-only and not in React Native's types; it balances a
// heading's lines so none ends on one stranded word.
const serif = { fontFamily: siteSerif, fontWeight: "400" as const, letterSpacing: -0.6, ...({ textWrap: "balance" } as object) };

// Web only (React Native has neither key): a 1px underline set clear of the
// descenders, and the menu's current page marked lower still.
export const UNDERLINE = { textDecorationThickness: 1, textUnderlineOffset: 3 } as object;
export const UNDERLINE_CURRENT = { textDecorationThickness: 1, textUnderlineOffset: 6 } as object;

export const SITE_HEADING_SIZE = StyleSheet.create({
  h1: { ...serif, fontSize: siteType.h1, lineHeight: leading(siteType.h1, 1.1) },
  h2: { ...serif, fontSize: siteType.h2, lineHeight: leading(siteType.h2, 1.2), marginTop: 40 },
  h3: { ...serif, fontSize: siteType.h3, lineHeight: leading(siteType.h3, 1.3), marginTop: 20 },
  h4: { fontSize: BODY, lineHeight: leading(BODY, 1.4), marginTop: 16, fontWeight: "600" },
  h5: { fontSize: siteType.h5, lineHeight: leading(siteType.h5, 1.4), marginTop: 14, fontWeight: "600" },
  h6: { fontSize: siteType.code, lineHeight: leading(siteType.code, 1.4), marginTop: 14, fontWeight: "600" },
});

/**
 * The same look on a wide screen: a larger display heading and a slightly
 * larger body, so a desktop page reads as designed for its width rather than
 * a phone column. Only sizes and spacing change.
 */
const WIDE = siteType.bodyDesktop;
export const SITE_WIDE_HEADING_SIZE = StyleSheet.create({
  ...SITE_HEADING_SIZE,
  h1: { ...serif, fontSize: siteType.h1Desktop, lineHeight: leading(siteType.h1Desktop, 1.05), letterSpacing: -1.2 },
  h2: { ...serif, fontSize: siteType.h2Desktop, lineHeight: leading(siteType.h2Desktop, 1.2), marginTop: 56 },
  h4: { fontSize: WIDE, lineHeight: leading(WIDE, 1.4), marginTop: 16, fontWeight: "600" },
});

export const makeSiteWideStyles = () => {
  const run = { fontSize: WIDE, lineHeight: leading(WIDE, 1.6) };
  return StyleSheet.create({
    body: { gap: 28 },
    paragraph: run,
    marker: run,
    itemText: run,
    quoteText: run,
  });
};

export const makeSiteStyles = (colors: Colors) => {
  const run = { fontSize: BODY, lineHeight: leading(BODY, 1.65) };
  return StyleSheet.create({
    body: { gap: 24 },
    paragraph: { ...run, color: colors.text },
    marker: { ...run, color: colors.muted, minWidth: 22 },
    itemText: { ...run, flexGrow: 1, flexShrink: 1, color: colors.text },
    list: { gap: 10, paddingLeft: 0 },
    quote: { borderLeftWidth: 2, borderLeftColor: colors.muted, paddingLeft: 18, paddingVertical: 2 },
    quoteText: { ...run, color: colors.muted, fontStyle: "italic" },
    code: {
      borderRadius: 6,
      backgroundColor: colors.chromeSurface,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    codeText: { color: colors.text2, fontFamily: fonts.mono, fontSize: siteType.code, lineHeight: leading(siteType.code, 1.6) },
    strong: { color: colors.text, fontWeight: "600" },
    inlineCode: { fontFamily: fonts.mono, fontSize: siteType.inlineCode, color: colors.text },
    link: {
      color: colors.text,
      textDecorationLine: "underline",
      textDecorationColor: colors.muted,
      ...UNDERLINE,
    },
  });
};
