import { Text as RNText, StyleSheet, type TextProps, type TextStyle } from "react-native";
import { fonts, leading, pointerType as t, touchType, tracking } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";

/**
 * Every voice in the application, drawn from the one type scale.
 *
 * ## What this table used to be
 *
 * Thirty-three variants holding **sixteen** sizes between them — 10, 10.5, 11,
 * 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16.5, 17, 21, 25 — most of them
 * a half-point from a neighbour doing the same job. `rail` at 13.5 and `tree`
 * at 13 are one role; so are `rowSub`, `hint`, `foot` and `code` at 12.5 beside
 * `meta` and `statLabel` at 12. Nothing chose those gaps. They are what happens
 * when a variant is added by copying the nearest one and nudging the number
 * until a single screen looks right.
 *
 * Every size now names a role in `pointerType` / `touchType`, so the table
 * holds seven sizes rather than sixteen, and a new variant has to say which
 * existing role it is rather than inventing a size between two others. Where a
 * variant ends in `Touch` it reads the touch scale — which is what that suffix
 * always meant, and previously expressed by being half a point larger.
 *
 * Weight, tracking, colour and transform remain each variant's own: the scale
 * governs size, not voice.
 *
 * CSS tracking is in `em` and CSS line-height is a multiplier; React Native
 * wants points for both, so every entry runs its size through `tracking()` /
 * `leading()` rather than carrying a pre-baked magic number.
 */
const variantsFor = (colors: Colors) => ({
  /** `.mark` — the wordmark in the top bar. */
  mark: {
    fontFamily: fonts.display,
    fontSize: t.body,
    lineHeight: leading(t.body, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.body, -0.02),
    color: colors.text,
  },
  /** `.badge` — the MIT open-source pill. */
  badge: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    fontWeight: "500",
    color: colors.text2,
  },
  /**
   * A link in the landing page's navigation bar.
   *
   * `muted` rather than `text`: the nav is how you get around, not what the
   * page is about, and four items in full ink at the top of a hero is a row
   * competing with the headline under it. The canvas draws them at 14 in its
   * mid grey, which is what this is.
   */
  navLink: {
    fontFamily: fonts.body,
    fontSize: t.meta + 2,
    lineHeight: leading(t.meta + 2, 1.55),
    color: colors.muted,
  },
  /**
   * The nav's quiet action — "Sign in" beside the filled one.
   *
   * Full ink and a weight, where `navLink` is neither: this is an action, and
   * the pair either side of the gap has to read as a pair. It is the same
   * weight as the button's label, in the page's own ink rather than on a fill.
   */
  navAction: {
    fontFamily: fonts.body,
    fontSize: t.meta + 2,
    lineHeight: leading(t.meta + 2, 1.55),
    fontWeight: "500",
    color: colors.text,
  },
  /** `.hero .sub` — the paragraph under the hero. Size is passed in (clamped). */
  heroSub: {
    fontFamily: fonts.body,
    color: colors.text2,
  },
  /** `.btn-white` label. */
  cta: {
    fontFamily: fonts.body,
    fontSize: t.lede,
    lineHeight: leading(t.lede, 1.55),
    fontWeight: "600",
    color: colors.ink,
  },
  /** `.ghost` link. */
  ghost: {
    fontFamily: fonts.body,
    fontSize: t.lede,
    lineHeight: leading(t.lede, 1.55),
    color: colors.text2,
  },
  /** `.alsoline`. */
  alsoLine: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    color: colors.muted,
  },
  /** `body` default. */
  body: {
    fontFamily: fonts.body,
    fontSize: t.lede,
    lineHeight: leading(t.lede, 1.55),
    color: colors.text,
  },
  /** `.railgroup h4` — the uppercase rail section headings. */
  railHead: {
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: leading(t.label, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.label, 0.13),
    textTransform: "uppercase",
    color: colors.muted,
  },
  /** `.railbtn`. */
  rail: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
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
    fontSize: touchType.ui,
    lineHeight: leading(touchType.ui, 1.4),
    fontWeight: "500",
    color: colors.text,
  },
  /** `.wsswitch`. */
  wsSwitch: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    fontWeight: "500",
    color: colors.text,
  },
  /** `.panehead h2`. */
  paneTitle: {
    fontFamily: fonts.display,
    fontSize: t.h2,
    lineHeight: leading(t.h2, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.h2, -0.025),
    color: colors.text,
  },
  /** `.panehead p`. */
  paneSub: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    color: colors.muted,
  },
  /** `.pill`. */
  pill: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    fontWeight: "600",
  },
  /** `.stat b`. */
  statValue: {
    fontFamily: fonts.display,
    fontSize: t.h2,
    lineHeight: leading(t.h2, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.h2, -0.03),
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  /** `.stat span`. */
  statLabel: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    color: colors.muted,
  },
  /** `.rowtitle`. */
  rowTitle: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.ui, -0.01),
    color: colors.text,
  },
  /**
   * A grouped list's heading — the settings list's, and nothing else's yet.
   *
   * `railHead` is 10.5pt at 0.13em in `muted`, and in a 216pt rail beside a
   * handful of rows that is a quiet label doing a small job. In the settings
   * list it was the *only* thing separating nineteen rows, and it was the
   * least visible type on the screen. Bigger, heavier, and in `text2`, with
   * the card edge underneath it now carrying the separation the heading used
   * to carry alone.
   */
  listGroup: {
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: leading(t.label, 1.5),
    fontWeight: "600",
    letterSpacing: tracking(t.label, 0.05),
    textTransform: "uppercase",
    color: colors.text2,
  },
  /**
   * The trailing value on a settings row, on a phone.
   *
   * `rowSub` at 12.5 is the pointer size and reads as a caption beside a
   * label you can already see. Here the value is half the reason the row
   * exists — "R2 · notes-bucket" is the answer, "Storage" is only the question — so
   * it is read at the size the rest of the phone is read at, one step under
   * the label rather than two. The same argument `railTouch` makes.
   */
  rowValueTouch: {
    fontFamily: fonts.body,
    fontSize: touchType.ui,
    lineHeight: leading(touchType.ui, 1.4),
    color: colors.muted,
  },
  /** `.rowsub`. */
  rowSub: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    color: colors.muted,
  },
  /** `.mini` button label. */
  mini: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    fontWeight: "600",
    color: colors.text,
  },
  /** `.tnode` — a row in the folder tree. */
  tree: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    color: colors.text2,
  },
  /**
   * The same row on a phone.
   *
   * 15.5 rather than 13, and `text` rather than `text2`. A phone's file list is
   * a list of *destinations* — `FolderView` is the only way to open a note
   * there — and a destination list is read at the size the rest of the phone is
   * read at. 13px dimmed is a supporting label beside a document you can
   * already see, which is what it is under a pointer and is not what it is here.
   *
   * (This said "the drawer is the only way to open a note there" until the
   * drawer went. The claim is unchanged and its subject moved: there is no left
   * panel at any density, so the folder page carries it.)
   */
  treeTouch: {
    fontFamily: fonts.body,
    fontSize: touchType.ui,
    lineHeight: leading(touchType.ui, 1.4),
    color: colors.text,
  },
  /** `.tnode .lock` — the trailing count / "private" marker. */
  treeMeta: {
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: leading(t.label, 1.55),
    color: colors.muted,
  },
  /**
   * `treeMeta` in the mono face — a key, at label size.
   *
   * The status bar's path and nothing else so far. Same size and leading as
   * `treeMeta`, so the two sit on one baseline in the same row; only the face
   * differs, which is the whole distinction being drawn: this one is a string
   * a person could type.
   */
  treeMetaMono: {
    fontFamily: fonts.mono,
    fontSize: t.label,
    lineHeight: leading(t.label, 1.55),
    color: colors.muted,
  },
  /** `.note h3`. */
  noteTitle: {
    fontFamily: fonts.display,
    fontSize: t.body,
    lineHeight: leading(t.body, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.body, -0.02),
    color: colors.text,
  },
  /** `.note pre`. */
  code: {
    fontFamily: fonts.mono,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.7),
    color: colors.text2,
  },
  /** `.copyfield .mono` and `.field .val`. */
  mono: {
    fontFamily: fonts.mono,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    color: colors.text2,
  },
  /** `.field label` and the "Your endpoint" eyebrow. */
  eyebrow: {
    fontFamily: fonts.body,
    fontSize: t.label,
    lineHeight: leading(t.label, 1.55),
    fontWeight: "600",
    letterSpacing: tracking(t.label, 0.06),
    textTransform: "uppercase",
    color: colors.muted,
  },
  /** `.check`. */
  check: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
    color: colors.text2,
  },
  /** `.hint`. */
  hint: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.6),
    color: colors.hintText,
  },
  /** `.foot`. */
  foot: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    color: colors.muted,
  },
  /** Small muted meta, e.g. "updated 2 minutes ago". */
  meta: {
    fontFamily: fonts.body,
    fontSize: t.meta,
    lineHeight: leading(t.meta, 1.55),
    color: colors.muted,
  },
  /** Error copy on the auth form. */
  error: {
    fontFamily: fonts.body,
    fontSize: t.ui,
    lineHeight: leading(t.ui, 1.55),
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
