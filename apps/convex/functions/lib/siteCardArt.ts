/**
 * A published website page's link preview, as a satori element tree.
 *
 * Pure and import-free for the reason `cardArt.ts` gives: the renderer is a
 * `"use node"` action, and the decisions worth asserting (sizes, copy, which
 * words are drawn) live in the shape, which a test can read without booting
 * Node.
 *
 * ## It belongs to the site, not to us
 *
 * `cardArt.ts` is our card: a shared note, handed from one person to another,
 * in Graphite with a petrol accent and our domain at the foot. This is the
 * opposite case. Somebody put a website on their own domain, and when a link
 * to it lands in a chat it should look like a page of that website, the way a
 * printed page looks like the book it came from. So the card is drawn from
 * the site's own vocabulary, and nothing else:
 *
 *   - the page title in Instrument Serif 400, which is what the page's own
 *     heading is set in (`features/site/siteFonts.ts`);
 *   - the site's name in Instrument Sans 600, which is how the site's header
 *     sets it (`SiteFrame.tsx`, `styles.name`);
 *   - the Paper ground and ink.
 *
 * **No accent, no mark, no `context.lc`.** The site's own footer already says
 * "Made with Context" to a visitor who opened the page; a credit on the image
 * would put our name into every conversation the site's owner starts, which is
 * the card advertising us on their behalf. The unfurl's caption shows the real
 * domain underneath the image in any case.
 *
 * ## Paper, and only Paper
 *
 * The site follows its visitor's theme; an image cannot. iMessage draws the
 * picture above a grey caption on a light bubble (`#E9E9EB`) or a dark one
 * (`#262628`), Slack on white or near-black. Paper (`#FFFDF9`) separates from
 * all four: on a light bubble it is a warmer, brighter sheet above the grey;
 * on a dark one it is a lit page. Graphite sits within a few percent of every
 * dark bubble and would dissolve into it, leaving a title floating on nothing.
 * Paper is also the palette that reads as a page rather than an app, and it
 * keeps a site's card visibly apart from our own Graphite share card.
 *
 * ## The home page draws one name, not two
 *
 * A site called "Seyi" usually has a home page titled "Seyi", or "Home", which
 * is a label rather than copy (`WebsitePage.tsx` draws no heading for it
 * either). Drawing both would say one word twice, so that card is the site's
 * name alone, set as the hero. See `isHomeTitle`.
 *
 * ## satori is not a browser
 *
 * Flexbox only, and every element with children needs `display: "flex"`.
 * There is no text measurement to auto-fit with, so the title's size is a
 * step function of its length (`siteTitleSize`), bounded at 60 characters by
 * the caller, and it wraps rather than truncating. `textWrap: "balance"`
 * matches the site's own heading, so a title never ends on one stranded word.
 */

/** 1200x630, what the page's `og:image:width/height` advertise. */
export const SITE_CARD_WIDTH = 1200;
export const SITE_CARD_HEIGHT = 630;

/*
  Paper, from `apps/mobile/features/design/tokens/colors.ts` (re-exported by
  `tokens.ts` as `lightColors`). Copied because `apps/convex` cannot import
  from `apps/mobile`.
*/
/** `lightColors.ground` */
const GROUND = "#FFFDF9";
/** `lightColors.text` */
const TEXT = "#1A1714";
/** `lightColors.line` */
const LINE = "rgba(26,23,20,0.09)";

/** The margin on every side. Wide on purpose: the card is mostly paper. */
const MARGIN_X = 88;
const MARGIN_Y = 76;
/** The width the title may use before it wraps. */
const MEASURE = SITE_CARD_WIDTH - MARGIN_X * 2;

/** The longest title the caller passes; longer is cut before it reaches here. */
export const MAX_SITE_CARD_TITLE = 60;

/**
 * The title's type size, by length.
 *
 * Four steps, because the serif is narrow and a one-word title at the size a
 * long one needs looks lost on a 1200px sheet. Checked against the rendered
 * card: 12 characters at 172 fit one line; 24 at 120 fit one line, two for
 * the widest letters; 40 at 100 and 60 at 88 land on two lines, three at
 * worst, and three lines of the smallest step still clear the site's name.
 */
export function siteTitleSize(title: string): number {
  const length = title.trim().length;
  if (length <= 12) return 172;
  if (length <= 24) return 120;
  if (length <= 40) return 100;
  return 88;
}

/**
 * Whether the page is the home page speaking as the site.
 *
 * True when the title is the site's name (ignoring case and surrounding
 * space), when it is the label "Home", or when it is empty. Any of those
 * would draw the same word twice, or draw a label as if it were a title.
 */
export function isHomeTitle(title: string, siteName: string): boolean {
  const t = title.trim().toLowerCase();
  return t === "" || t === "home" || t === siteName.trim().toLowerCase();
}

export interface SiteCardFacts {
  /** The page's title, at most `MAX_SITE_CARD_TITLE` characters. */
  title: string;
  /** The site's name, as its header draws it. */
  siteName: string;
}

/** The card, as satori's element tree. */
export function siteCardElement(facts: SiteCardFacts): unknown {
  const siteName = facts.siteName.trim();
  const home = isHomeTitle(facts.title, siteName);
  return {
    type: "div",
    props: {
      style: {
        width: SITE_CARD_WIDTH,
        height: SITE_CARD_HEIGHT,
        display: "flex",
        flexDirection: "column",
        padding: `${MARGIN_Y}px ${MARGIN_X}px`,
        backgroundColor: GROUND,
        // One hairline at the sheet's edge. A light bubble's caption is grey
        // and Slack's ground is white; the line is what keeps paper from
        // bleeding into white where the platform draws no border of its own.
        border: `2px solid ${LINE}`,
      },
      children: home
        ? [spacer(), title(siteName)]
        : [name(siteName), spacer(), title(facts.title.trim())],
    },
  };
}

/** The site's name, set as the site's own header sets it. */
function name(siteName: string): unknown {
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        fontFamily: "Instrument Sans",
        fontWeight: 600,
        // 44, not the header's 19-to-64 ratio: an unfurl is drawn around 270px
        // wide, where anything smaller than this is an unreadable smudge.
        fontSize: 44,
        lineHeight: 1.2,
        letterSpacing: "-0.01em",
        color: TEXT,
        maxWidth: MEASURE,
        // One line, always: a name with no spaces would otherwise run off the
        // sheet, and satori clips silently rather than complaining.
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
      },
      children: siteName,
    },
  };
}

/**
 * The hero: the page's title, set low on the sheet.
 *
 * Bottom-aligned rather than centred, so a one-line title and a three-line
 * one share a baseline edge and the space above them is the page's margin,
 * not a gap that changes with every title.
 */
function title(text: string): unknown {
  const size = siteTitleSize(text);
  return {
    type: "div",
    props: {
      style: {
        display: "flex",
        fontFamily: "Instrument Serif",
        fontWeight: 400,
        fontSize: size,
        lineHeight: 1.04,
        // The site's desktop heading tracks at -1.2 on 64px; the same ratio.
        letterSpacing: "-0.019em",
        color: TEXT,
        maxWidth: MEASURE,
        textWrap: "balance",
        // An unbroken 60-character string breaks rather than leaving the sheet.
        wordBreak: "break-word",
      },
      children: text,
    },
  };
}

function spacer(): unknown {
  return { type: "div", props: { style: { display: "flex", flexGrow: 1 } } };
}
