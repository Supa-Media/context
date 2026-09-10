import { Fragment } from "react";
import {
  StyleSheet,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
} from "react-native";
import { densityFor } from "../../app/frame";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { crumbsFor, type Crumb } from "./crumbs";
import type { Visibility } from "./types";

/**
 * Where the open note lives, and who can see it.
 *
 * This is what freed the top of the editor. The note used to carry a card
 * header — its name, two chips, a byte count — and beneath that a row of seven
 * buttons, all of it above the first line of the document. A breadcrumb says
 * the same thing in one line, at the top of the region rather than on top of
 * the note, and the operations moved to the row's own menu.
 *
 * ## The segments are real navigation, and the last one is the place
 *
 * Each folder is pressable and selects that folder, which is what a breadcrumb
 * is *for* — a path you can only read is a label. The last segment, the note or
 * the folder you are standing in, is not: pressing it would re-select what you
 * are already looking at.
 *
 * **The leaf is drawn, on both densities.** It was dropped from the phone's
 * line once, on the argument that the note names itself inside the document, so
 * a trailing segment says the same words twice — and that produced the two
 * screenshots this component was rebuilt from: `1-projects/october-trip.md`
 * rendered as `@seyi / 1-projects`, and `index.md` rendered as `@seyi` alone
 * over an open editor. Both of the names it was deferring to live *inside the
 * scroller*, so they are gone the moment somebody reads past the first screen;
 * the band is what stays. `crumbs.ts` carries the rule and the argument.
 *
 * ## The visibility chip is the whole sentence, not the tree's marker
 *
 * The tree marks only exceptions, because drawing a folder's default on every
 * one of its files buries the one note that differs. Here there is room, so the
 * chip is explicit — "team — follows its folder" rather than an absent marker —
 * and a note that inherits says so instead of merely looking unlabelled.
 *
 * ## On a phone it is a line above the note, not a bar across it
 *
 * No fill and no rule. Under a pointer this sits at the top of one region among
 * four and the hairline is what separates it from the tab strip above and the
 * document below. On a phone there is nothing above it but two floating buttons
 * and nothing beside it at all, so the fill and the rule are a bar drawn around
 * a single line of type — which is the detail that makes a phone screen read as
 * a window that got narrow.
 *
 * **And it drops the context segment**, which is not a cosmetic trim. The
 * phone's top bar carries the context switcher two lines above this, so
 * "@seyi" here is the same word twice on a 390pt screen — and it was the word
 * being paid for: at three segments plus a chip the line ellipsised at *both*
 * ends, so the one segment that actually names the open note read "context…".
 * The folders are still there and still pressable; what is gone is the segment
 * the chrome above already states. A pointer layout has the width for both and
 * keeps it.
 *
 * ## `pathOnly`: the phone's version, which is a path and nothing else
 *
 * The compact styling above was written and then never drawn — `BrowsePane`
 * gated the whole line on a pointer layout, so on a phone the only way into a
 * folder was the drawer. `pathOnly` is what the phone renders instead, and it
 * is subtractive rather than a second design: the same segments, the same press
 * targets, with the two things a phone already says elsewhere removed.
 *
 * - **The leaf, and the folders, and nothing else.** This is a *position*: the
 *   line answers "where am I" completely, or it does not answer it. See the
 *   header for what deleting the leaf cost.
 * - **No visibility chip.** A note carries it as a Properties row and a folder
 *   states it in a sentence directly beneath. Both are fuller than the brief
 *   chip, and both are already on screen.
 * - **No context segment, because it is not a segment any more — it is the
 *   button in front of these.** `NavBand` draws `CurrentContextPill` at the
 *   head of this row, so the context is named once, is pressable, and opens its
 *   own root: the way *up* that the segment used to be, drawn as a control
 *   rather than as monospace.
 *
 *   This is the second answer to that question and the first one was wrong.
 *   The segment was simply deleted, on the reasoning that the strip above named
 *   the context already — which removed the duplication and the way up
 *   together, leaving a top-level folder with an empty path row and no route to
 *   its own root. A thing that is in two places is moved to one, not removed
 *   from both.
 *
 * ## It returns bare segments, and `NavBand` owns the scroller
 *
 * `3-resources/books/reading-notes/…` is wider than 390pt within three
 * segments, and the two ways to fit a *name* are both worse than scrolling:
 * wrapping makes the band a variable number of rows, ellipsising leaves the
 * segment you are standing next to unreadable. `ContextStrip`'s rule holds
 * unchanged — **no label is ever shortened**, the row gets longer, the scroll
 * absorbs it.
 *
 * **What the row used to be unable to absorb was depth, and that expired.**
 * The segment that scrolls off the trailing edge can be the leaf, and for a
 * while that was answered by capping the folder count and eliding the middle
 * to `…` — `crumbs.ts` carried `MAX_FOLDER_CRUMBS`, and a caller that needed
 * the leaf's fit *guaranteed* rather than merely bounded passed it a character
 * budget (`phoneRowBudget`, once below this comment). Both are gone: the row
 * is already a `ScrollView`, so it answers "what fits" for free, correctly, at
 * every width and every font size — a question the elision was only ever
 * approximating. `crumbs.ts`'s header has the fuller argument and
 * `docs/decisions/app-and-console.md`'s "Two, not three" and "A count cannot
 * guarantee a fit" record what this supersedes and why it is not a reversal:
 * every segment is reachable now, where a cap only kept two of them so.
 *
 * The scroller is one level up because the context button scrolls **with** these
 * segments: they are one line, and a button that stayed still while its own path
 * slid out from under it is two controls pretending to be one. It starts at its
 * leading edge — the pill and the ancestors nearest it — because the leaf is
 * already stated a line below, as the note's own inline title; a control you
 * cannot reach is worse than a fact you may have to scroll to.
 */

export function Breadcrumb({
  path,
  title,
  contextLabel,
  visibility,
  inherited,
  exception,
  readOnly,
  onSelectFolder,
  pathOnly,
}: {
  path: string;
  /**
   * What to call the note, where its filename is not what it is called.
   *
   * A captured note's filename is a content hash — `3efac11d4eead8832e5b1236`
   * — so the one line on a phone that names what is on screen was naming
   * nothing. `noteHeading` in `frontmatter.ts` resolves it: the frontmatter's
   * `title` or `subject` first, then the body's own `# Heading`, then the
   * filename.
   *
   * Passed in rather than derived, because deriving it needs the note's *text*
   * and this component is given a path. `BrowsePane` has the open draft; a
   * breadcrumb that fetched one would be a breadcrumb that could not be drawn
   * for a folder.
   *
   * Omitted for a folder and for a file whose text is not the one open, and the
   * basename — without its `.md`, which is filing rather than a name — is then
   * what the leaf says.
   */
  title?: string;
  /** "@seyi" — the context is the first segment, and it is the product's root. */
  contextLabel: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  onSelectFolder?: (folder: string) => void;
  /**
   * Draw the path and nothing else — see the header. The phone's shape.
   *
   * The whole path — every ancestor **and** the place itself, whichever kind
   * it names. What it drops is the context segment and the visibility chip,
   * both of which the surfaces around it already carry.
   */
  pathOnly?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const windowWidth = useWindowDimensions().width;
  const compact = densityFor(windowWidth) === "compact";
  /*
    The whole path, leaf included, on both densities. `pathOnly` is the phone:
    a context pill, then this, on a `ScrollView` row — see the header for why
    that scroller is the answer to "does the leaf fit" rather than a folder
    count or a character budget. The pointer layout draws the same crumbs
    beside a visibility chip it has the width for.
  */
  const crumbs = crumbsFor(path, { title });

  if (pathOnly === true) {
    /*
      The context's own root, where the pill in front of these is already the
      answer. `NavBand` draws that pill and this returns the *rest* of the line,
      so `null` is a complete answer rather than an empty band.
    */
    if (crumbs.length === 0) return null;
    return (
      <>
        {crumbs.map((crumb) => (
          <Fragment key={keyFor(crumb)}>
            {/*
              A separator in front of every crumb, the first included — because
              the thing to its left is the context button, and `@seyi 1-projects`
              with nothing between them reads as two unrelated controls rather
              than as a path.
            */}
            <Separator />
            <Segment
              crumb={crumb}
              onSelectFolder={onSelectFolder}
              /*
                The leaf is the only thing on a phone naming what is open once
                the document has scrolled, so it carries the weight — and the
                body face when it is a *title* somebody wrote rather than a file
                name. See `leafText`.
              */
              leafStyle={styles.pathLeaf}
              titled={title !== undefined}
            />
          </Fragment>
        ))}
      </>
    );
  }

  return (
    <View style={[styles.bar, compact && styles.barCompact]}>
      {compact ? null : (
        <Text variant="mono" style={styles.context} numberOfLines={1}>
          {contextLabel}
        </Text>
      )}

      {crumbs.map((crumb, index) => (
        <Fragment key={keyFor(crumb)}>
          {/*
            A separator joins two things. With the context segment dropped at
            `compact` there is nothing to the left of the first crumb, and an
            unconditional one renders the path as "/ 1-projects / note" — a
            leading slash that reads as an absolute path into the bucket root,
            which is precisely the addressing this product does not use.
          */}
          {compact && index === 0 ? null : <Separator />}
          <Segment
            crumb={crumb}
            onSelectFolder={onSelectFolder}
            leafStyle={[styles.leaf, compact && styles.leafCompact]}
            titled={title !== undefined}
          />
        </Fragment>
      ))}

      <View style={styles.spacer} />

      <View
        style={[
          styles.chip,
          readOnly
            ? styles.chipGenerated
            : visibility === "team"
              ? styles.chipTeam
              : styles.chipPrivate,
        ]}
      >
        <Text
          style={[
            styles.chipLabel,
            readOnly
              ? styles.chipGeneratedLabel
              : visibility === "team"
                ? styles.chipTeamLabel
                : styles.chipPrivateLabel,
          ]}
        >
          {describe({ visibility, inherited, exception, readOnly, brief: compact })}
        </Text>
      </View>
    </View>
  );
}

/**
 * A React key. The path is unique and stable, so there is no need for the
 * index this once fell back to for a gap that stood for several at once.
 */
function keyFor(crumb: Crumb): string {
  return `${crumb.kind}:${crumb.path}`;
}

/**
 * One crumb, drawn as what it is.
 *
 * A folder is a control — pressing it lists that folder, which is what a
 * breadcrumb is *for*; a path you can only read is a label. The leaf is not:
 * pressing it would re-select what is already open.
 */
function Segment({
  crumb,
  onSelectFolder,
  leafStyle,
  titled,
}: {
  crumb: Crumb;
  onSelectFolder?: (folder: string) => void;
  leafStyle: StyleProp<TextStyle>;
  /** Whether the leaf's label is a title somebody wrote. See `leafText`. */
  titled: boolean;
}) {
  const styles = useThemedStyles(makeStyles);

  if (crumb.kind === "leaf") {
    return (
      <Text
        /*
          `mono` for a path segment and the body face for a title. The monospace
          is right when this line is a *path* — it is what makes the separators
          line up and the segments read as file names — and wrong the moment the
          last segment is a sentence somebody wrote, which is what `title` is.
        */
        variant={titled ? "body" : "mono"}
        style={leafStyle}
        numberOfLines={1}
        testID="breadcrumb-leaf"
      >
        {crumb.label}
      </Text>
    );
  }

  return (
    <PressRow
      accessibilityLabel={`Open ${crumb.path}`}
      onPress={() => onSelectFolder?.(crumb.path)}
      radius={radii.xs}
      style={styles.segment}
      hoverStyle={styles.segmentHover}
      /*
        The drawn box is `layout.crumbSegmentHeight` — an 11px mono label
        inside `segment`'s own 1pt of vertical padding — which is short of
        `layout.minTouchTarget` by design: `segment` pads for legibility, not
        for a thumb. `layout.navBandSegmentSlop` is `explorerRowSlop`'s own
        shape, `(minTouchTarget - crumbSegmentHeight) / 2`, and buys the rest
        of the floor back on the pressable rather than growing the visual —
        `PressRow`'s own rule, "pad the pressable, never the visual". This
        matters more now than it used to: with the elision gone there are more
        of these on the row to hit, not fewer.
      */
      hitSlop={NAV_BAND_SEGMENT_HIT_SLOP}
      testID={`breadcrumb-folder-${crumb.path}`}
    >
      <Text variant="mono" style={styles.folder} numberOfLines={1}>
        {crumb.label}
      </Text>
    </PressRow>
  );
}

/**
 * Exported so `breadcrumbPath.test.ts` can hold the exact object `Segment`
 * passes to `PressRow`, rather than re-deriving it: react-native-web's `View`
 * drops `hitSlop` from the props it forwards to the DOM (see `forwardedProps`
 * in `View`'s own source) before it ever reaches an element a test could
 * inspect, so this is the one thing a jsdom test can actually hold to prove
 * the slop is still wired up. What it buys is real only on the platforms
 * whose `Pressable` honours `hitSlop` for hit-testing — today, everywhere
 * except the web build.
 */
export const NAV_BAND_SEGMENT_HIT_SLOP = {
  top: layout.navBandSegmentSlop,
  bottom: layout.navBandSegmentSlop,
};

function Separator() {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="mono" style={styles.separator} aria-hidden>
      /
    </Text>
  );
}

/**
 * The chip's words.
 *
 * Exported and tested on its own because it is a **claim about who can read
 * this note**, and the three cases are easy to collapse into two by somebody
 * tidying up — at which point a note that merely follows a `team` folder and a
 * note deliberately shared as an exception look identical, and the one you can
 * safely make private without thinking is no longer distinguishable.
 *
 * `brief` is the phone's wording, and it is a second *phrasing* rather than a
 * second function for exactly that reason: the branch stays here, so a case
 * cannot be dropped from one surface and kept on the other. "team — follows
 * its folder" is 24 characters beside a note name on a 390pt screen, and it
 * was winning — the name ellipsised while the sentence did not. The
 * distinction the long form exists to draw survives the trim: `set here` and
 * `inherited` are still two different answers, and still not the same as the
 * manifest's own.
 */
export function describe({
  visibility,
  inherited,
  exception,
  readOnly,
  brief = false,
}: {
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  /** The phone's shorter wording. Same three cases. */
  brief?: boolean;
}): string {
  if (readOnly) return brief ? "access map" : "the access map";
  if (exception) return brief ? `${visibility} · set here` : `${visibility} — set on this note`;
  return brief ? `${inherited} · inherited` : `${inherited} — follows its folder`;
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: space.x4,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  /** See the file comment. */
  barCompact: {
    paddingHorizontal: layout.readingMargin,
    /*
      Vertical padding, not zero.

      It was zero so the line would sit tight under the top bar, and it is what
      made Share collide with the breadcrumb: the row has no height of its own,
      the crumb contributes about 17pt of type, and `Button` brings 6pt of
      padding either side — so the button was the tallest thing in a row with
      no room for it and overflowed both ways. The height is reserved here now
      and `BrowsePane.noteHead` holds the floor; see its comment.
    */
    paddingTop: 2,
    paddingBottom: space.x2,
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
  /**
   * The `pathOnly` line, which carries nothing that can overflow it.
   *
   * `barCompact` reserves height for a `Button` because the full line used to
   * hold Share; there is no button here — the phone's actions are in the top
   * bar's group — so the row is type on both counts and the floor comes off.
   * The touch targets are the segments' own, widened by `segment`.
   *
   * **And no horizontal padding**: `NavBand` pays it for both of its rows, so
   * the pills above this line and the segments on it start at the same
   * character. Paying it here as well would indent the path by a second reading
   * margin.
   */
  barPath: { paddingTop: 0, paddingBottom: space.x2, paddingHorizontal: 0, minHeight: 0 },
  context: { color: colors.text2, fontSize: 11 },
  separator: { color: colors.heroDim, fontSize: 11 },
  segment: { paddingHorizontal: 3, paddingVertical: 1, borderRadius: radii.xs },
  segmentHover: { backgroundColor: colors.surface3 },
  folder: { color: colors.muted, fontSize: 11 },
  leaf: { color: colors.text, fontSize: 11 },
  /**
   * The note's own name, at the size a title is read at.
   *
   * 11px is right for the trailing segment of a path in a bar that also carries
   * a tab strip and a tree; on a phone this line is the only thing naming what
   * is on screen, and the folders in front of it are the supporting detail
   * rather than the other way round.
   */
  leafCompact: { fontSize: 14, fontWeight: "600" },
  /**
   * The leaf on the phone's band, which is a **row of controls** rather than a
   * line above a document.
   *
   * `leafCompact`'s 14pt was sized for a line that stood alone over the note.
   * This one sits between 11pt folder segments and a context pill, and a leaf
   * three points taller than its own path would push the row's height around
   * every time somebody opened a note. Same size as the folders, and the weight
   * and the full-strength colour are what separate *where you are* from the
   * ancestors leading to it.
   */
  pathLeaf: { color: colors.text, fontSize: 11, fontWeight: "600" },
  spacer: { flex: 1, minWidth: space.x3 },

  chip: {
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 1,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  chipLabel: { fontSize: 10, fontFamily: fonts.body },
  chipTeam: { backgroundColor: colors.okWash, borderColor: colors.okBorder },
  chipTeamLabel: { color: colors.okText },
  chipPrivate: { backgroundColor: colors.surface3, borderColor: colors.lineStrong },
  chipPrivateLabel: { color: colors.text2 },
  chipGenerated: { backgroundColor: "transparent", borderColor: colors.line },
  chipGeneratedLabel: { color: colors.muted },
});
