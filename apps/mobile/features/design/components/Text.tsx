import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from "react-native";
import { fonts, leading, tracking } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";

/**
 * The type scale from `docs/design/console-mockup.html`.
 *
 * CSS tracking is in `em` and CSS line-height is a multiplier; React Native
 * wants points for both, so every entry runs its size through `tracking()` /
 * `leading()` rather than carrying a pre-baked magic number.
 */
const variantsFor = (colors: Colors) => ({
  /** `.mark` — the wordmark in the top bar. */
  mark: {
    fontFamily: fonts.display,
    fontSize: 17,
    lineHeight: leading(17, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(17, -0.02),
    color: colors.text,
  },
  /** `.badge` — the MIT open-source pill. */
  badge: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: leading(13, 1.55),
    fontWeight: "500",
    color: colors.text2,
  },
  /** `.hero .sub` — the paragraph under the hero. Size is passed in (clamped). */
  heroSub: {
    fontFamily: fonts.body,
    color: colors.text2,
  },
  /** `.btn-white` label. */
  cta: {
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: leading(15.5, 1.55),
    fontWeight: "600",
    color: colors.ink,
  },
  /** `.ghost` link. */
  ghost: {
    fontFamily: fonts.body,
    fontSize: 14.5,
    lineHeight: leading(14.5, 1.55),
    color: colors.text2,
  },
  /** `.alsoline`. */
  alsoLine: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: leading(13.5, 1.55),
    color: colors.muted,
  },
  /** `body` default. */
  body: {
    fontFamily: fonts.body,
    fontSize: 15,
    lineHeight: leading(15, 1.55),
    color: colors.text,
  },
  /** `.railgroup h4` — the uppercase rail section headings. */
  railHead: {
    fontFamily: fonts.body,
    fontSize: 10.5,
    lineHeight: leading(10.5, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(10.5, 0.13),
    textTransform: "uppercase",
    color: colors.muted,
  },
  /** `.railbtn`. */
  rail: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: leading(13.5, 1.55),
    fontWeight: "500",
    color: colors.text2,
  },
  /**
   * `.railbtn` on a phone.
   *
   * The rail is a *sheet* there, and the whole of navigation — the app panes,
   * every other context, sign-out — is reachable through it and nowhere else.
   * A list that is the only way out of a screen is read at the size the screen
   * is read at, not at the size of a supporting label in a 216pt column.
   */
  railTouch: {
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: leading(15.5, 1.4),
    fontWeight: "500",
    color: colors.text,
  },
  /** `.wsswitch`. */
  wsSwitch: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: leading(13, 1.55),
    fontWeight: "500",
    color: colors.text,
  },
  /** `.panehead h2`. */
  paneTitle: {
    fontFamily: fonts.display,
    fontSize: 21,
    lineHeight: leading(21, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(21, -0.025),
    color: colors.text,
  },
  /** `.panehead p`. */
  paneSub: {
    fontFamily: fonts.body,
    fontSize: 13.5,
    lineHeight: leading(13.5, 1.55),
    color: colors.muted,
  },
  /** `.pill`. */
  pill: {
    fontFamily: fonts.body,
    fontSize: 11.5,
    lineHeight: leading(11.5, 1.55),
    fontWeight: "600",
  },
  /** `.stat b`. */
  statValue: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: leading(25, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(25, -0.03),
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  /** `.stat span`. */
  statLabel: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: leading(12, 1.55),
    color: colors.muted,
  },
  /** `.rowtitle`. */
  rowTitle: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: leading(14, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(14, -0.01),
    color: colors.text,
  },
  /** `.rowsub`. */
  rowSub: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.55),
    color: colors.muted,
  },
  /** `.mini` button label. */
  mini: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.55),
    fontWeight: "600",
    color: colors.text,
  },
  /** `.tnode` — a row in the folder tree. */
  tree: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: leading(13, 1.55),
    color: colors.text2,
  },
  /**
   * The same row on a phone.
   *
   * 15.5 rather than 13, and `text` rather than `text2`. The tree is a list of
   * *destinations* on a phone — the drawer is the only way to open a note
   * there — and a destination list is read at the size the rest of the phone is
   * read at. 13px dimmed is a supporting label beside a document you can
   * already see, which is what it is under a pointer and is not what it is here.
   */
  treeTouch: {
    fontFamily: fonts.body,
    fontSize: 15.5,
    lineHeight: leading(15.5, 1.4),
    color: colors.text,
  },
  /** `.tnode .lock` — the trailing count / "private" marker. */
  treeMeta: {
    fontFamily: fonts.body,
    fontSize: 10,
    lineHeight: leading(10, 1.55),
    color: colors.muted,
  },
  /** `.note h3`. */
  noteTitle: {
    fontFamily: fonts.display,
    fontSize: 16.5,
    lineHeight: leading(16.5, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(16.5, -0.02),
    color: colors.text,
  },
  /** `.note pre`. */
  code: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.7),
    color: colors.text2,
  },
  /** `.copyfield .mono` and `.field .val`. */
  mono: {
    fontFamily: fonts.mono,
    fontSize: 13,
    lineHeight: leading(13, 1.55),
    color: colors.text2,
  },
  /** `.field label` and the "Your endpoint" eyebrow. */
  eyebrow: {
    fontFamily: fonts.body,
    fontSize: 11,
    lineHeight: leading(11, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(11, 0.06),
    textTransform: "uppercase",
    color: colors.muted,
  },
  /** `.check`. */
  check: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: leading(13, 1.55),
    color: colors.text2,
  },
  /** `.hint`. */
  hint: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.6),
    color: colors.hintText,
  },
  /** `.foot`. */
  foot: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: leading(12.5, 1.55),
    color: colors.muted,
  },
  /** Small muted meta, e.g. "updated 2 minutes ago". */
  meta: {
    fontFamily: fonts.body,
    fontSize: 12,
    lineHeight: leading(12, 1.55),
    color: colors.muted,
  },
  /** Error copy on the auth form. */
  error: {
    fontFamily: fonts.body,
    fontSize: 13,
    lineHeight: leading(13, 1.55),
    color: colors.critText,
  },
}) satisfies Record<string, TextStyle>;

export type TextVariant = keyof ReturnType<typeof variantsFor>;

const makeStyles = (colors: Colors) => StyleSheet.create(variantsFor(colors));

export interface ContextTextProps extends TextProps {
  variant?: TextVariant;
}

export function Text({ variant = "body", style, ...rest }: ContextTextProps) {
  const styles = useThemedStyles(makeStyles);
  return <RNText {...rest} style={[styles[variant], style]} />;
}

/**
 * The raw variant styles, for callers that need to compose rather than nest.
 *
 * A hook rather than the constant it used to be: the styles now depend on the
 * palette in force, and a caller composing with them has to be re-rendered
 * when that changes just as `Text` itself does.
 */
export function useTextStyles() {
  return useThemedStyles(makeStyles);
}
