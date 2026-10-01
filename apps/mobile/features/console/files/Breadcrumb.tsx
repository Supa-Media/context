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
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, pointerType as t, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useRightClick } from "./rightClick";
import { crumbsFor, type Crumb } from "./crumbs";

/**
 * Where the open note lives.
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
 * ## No visibility chip, on either density
 *
 * It ended the line with "team · inherited", "private · set here" and so on.
 * Over every note that is the ordinary state of a note, spelled in words a
 * reader had to decode, so it read as clutter (owner, 2026-09-27). Who can read
 * a note is answered where somebody goes to change it: the Share dialog, and
 * the tree's marks on the exceptions.
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
 * being paid for: at three segments plus a chip (since removed) the line ellipsised at *both*
 * ends, so the one segment that actually names the open note read "context…".
 * The folders are still there and still pressable; what is gone is the segment
 * the chrome above already states. A pointer layout has the width for both and
 * keeps it.
 *
 * ## A phone draws none of this
 *
 * It drew `pathOnly` — the folders and the leaf, behind the workspace's pill —
 * until the owner's review of the phone Home (2026-10-01) took the path off the
 * top of notes. The way up there is the ‹ back button (`home/phoneBack.ts`).
 */

export function Breadcrumb({
  path,
  title,
  onSelectFolder,
  onFolderMenu,
  history,
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
  onSelectFolder?: (folder: string) => void;
  /**
   * Right-click on a folder segment.
   *
   * The breadcrumb is the fastest route to a parent folder's verbs and offered
   * none of them — the tree is the only place a folder could be created in,
   * addressed or have its visibility set, and the crumb naming that very folder
   * was inert to the second mouse button.
   *
   * Folder segments only. The leaf is not a control here (pressing it would
   * re-select what is already open) and giving it a menu would make it one
   * halfway. Returns whether a menu opened — see `rightClick.web.ts`.
   */
  onFolderMenu?: (folder: string, anchor: { x: number; y: number }) => boolean;
  /**
   * `‹` and `›`, at the head of the line.
   *
   * **This is the pointer's half of a control the phone has had all along.**
   * `history.ts` held the stack and `ConsoleBottomBar` drew the pair, and
   * `frame.ts` draws that bar at `compact` only — so on a desktop the console
   * kept a full history of where somebody had been and offered no way to walk
   * it. "The note I was just looking at" was reachable by finding it in the
   * tree again, which is the defect the phone's toolbar was built to fix.
   *
   * Here rather than in the tab strip above, because tabs are a *set* of open
   * notes and this is an *order* of visits — two tabs can be open while you
   * have moved between them six times. And at the head of the path because
   * that is where every browser and Obsidian put them, which is the whole
   * reason they need no label.
   *
   * The pointer's only: a phone has ‹ back at the top left instead.
   */
  history?: {
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
  };
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const windowWidth = useWindowDimensions().width;
  const compact = densityFor(windowWidth) === "compact";
  /*
    The whole path, leaf included — `crumbs.ts` decides what each crumb is.
  */
  const crumbs = crumbsFor(path, { title });

  /*
    THE POINTER LINE IS THE NOTE'S FOLDERS, AND NOTHING THE PAGE ALREADY SAYS.

    It was `@seyi / 1-projects / Context.LC — build decisions`, and two thirds
    of that is drawn twice within 90pt: the workspace is the switcher chip in
    the title bar, directly above, and the note's own name is the H1 directly
    below, at 30pt. A line that repeats its neighbours in a smaller face is a
    line a reader learns to skip, and the canvas draws neither — `spirit /
    bible-study / kings`, the folders and the folders only, which is the one
    fact on that line nothing else on screen carries.

  */
  const folders = compact ? crumbs : crumbs.filter((crumb) => crumb.kind === "folder");

  return (
    <View style={[styles.bar, compact && styles.barCompact]}>
      {history === undefined ? null : (
        <View style={styles.history}>
          <Step
            direction="back"
            enabled={history.canBack}
            onPress={history.onBack}
            colors={colors}
            styles={styles}
          />
          <Step
            direction="forward"
            enabled={history.canForward}
            onPress={history.onForward}
            colors={colors}
            styles={styles}
          />
        </View>
      )}
      {folders.map((crumb, index) => (
        <Fragment key={keyFor(crumb)}>
          {/*
            A separator joins two things, and there is nothing to the left of
            the first crumb now that the context segment is gone from this
            density too. An unconditional one renders the path as "/ 1-projects
            / note" — a leading slash that reads as an absolute path into the
            bucket root, which is precisely the addressing this product does
            not use.
          */}
          {index === 0 ? null : <Separator />}
          <Segment
            crumb={crumb}
            onSelectFolder={onSelectFolder}
            onFolderMenu={onFolderMenu}
            leafStyle={[styles.leaf, compact && styles.leafCompact]}
            titled={title !== undefined}
          />
        </Fragment>
      ))}

      {/*
        No "who can see this" clause at the end of the line. It said `team ·
        inherited` over every note, which is the ordinary state of a note and
        read as clutter a reader had to decode (owner, 2026-09-27). Who can
        read a note is answered where somebody goes to change it: the Share
        dialog, and the tree's own marks.
      */}
      <View style={styles.spacer} />
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
  onFolderMenu,
  leafStyle,
  titled,
}: {
  crumb: Crumb;
  onSelectFolder?: (folder: string) => void;
  /** Right-click, on a folder segment. See `Breadcrumb`'s own prop. */
  onFolderMenu?: (folder: string, anchor: { x: number; y: number }) => boolean;
  leafStyle: StyleProp<TextStyle>;
  /**
   * Whether the leaf's label is a title somebody wrote rather than the note's
   * filename — decides the body face below, where `crumb.kind === "leaf"` is
   * drawn.
   */
  titled: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    A wrapper, for the reason `FolderView`'s rows use one: react-native-web
    forwards no `onContextMenu`, so the real node is reached through a plain
    `View`. Declared before the leaf's early return because hooks are not
    conditional — the leaf simply never attaches it, which is the same answer
    `useRightClick(undefined)` gives.
  */
  const rightClick = useRightClick(
    onFolderMenu === undefined || crumb.kind === "leaf"
      ? undefined
      : (anchor) => onFolderMenu(crumb.path, anchor),
  );

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
    <View ref={rightClick.ref} collapsable={false}>
      <PressRow
        accessibilityLabel={`Open ${crumb.path}`}
        onPress={() => onSelectFolder?.(crumb.path)}
        radius={radii.xs}
        style={styles.segment}
        hoverStyle={styles.segmentHover}
        testID={`breadcrumb-folder-${crumb.path}`}
      >
        <Text variant="mono" style={styles.folder} numberOfLines={1}>
          {crumb.label}
        </Text>
      </PressRow>
    </View>
  );
}

/** Bought back around a 24pt box to reach `layout.minTouchTarget`. */
const STEP_SLOP = Math.round((layout.minTouchTarget - 24) / 2);

/**
 * One of `‹` `›`.
 *
 * **Dimmed in place rather than removed at the ends of the history**, which is
 * `ConsoleBottomBar`'s rule for the same pair and is right for the same
 * reason: these two spend most of a session with at least one of them
 * unavailable, and a line whose first two positions come and go moves every
 * segment beside them each time somebody navigates.
 *
 * Unavailable is `disabled`, which `PressRow` passes to `Pressable`: it stops
 * the press, takes the row out of the tab order, and — the part that was
 * missing when this was only an absent handler — announces the control as
 * unavailable rather than letting a screen reader offer "Go back" on a console
 * with nowhere to go back to.
 */
function Step({
  direction,
  enabled,
  onPress,
  colors,
  styles,
}: {
  direction: "back" | "forward";
  enabled: boolean;
  onPress: () => void;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <PressRow
      accessibilityLabel={direction === "back" ? "Go back" : "Go forward"}
      onPress={enabled ? onPress : undefined}
      // Drawn, and honest about having nothing behind it. See `PressRow`.
      disabled={!enabled}
      style={styles.step}
      hoverStyle={enabled ? styles.stepHover : undefined}
      radius={radii.md}
      // The drawn box is 24pt and the target is not: `minTouchTarget` is bought
      // back in slop, which is this file's own rule for a row shorter than it.
      hitSlop={{ top: STEP_SLOP, bottom: STEP_SLOP, left: STEP_SLOP, right: STEP_SLOP }}
    >
      <Icon
        name={direction === "back" ? "chevronLeft" : "chevronRight"}
        size={13}
        color={enabled ? colors.chromeMuted : colors.line}
      />
    </PressRow>
  );
}

function Separator() {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="mono" style={styles.separator} aria-hidden>
      /
    </Text>
  );
}


const makeStyles = (colors: Colors) => StyleSheet.create({
  /**
   * The pointer layout's line, and it is a line rather than a bar.
   *
   * **No fill and no rule**, which reverses what this style used to be. It had
   * `surface` behind it and a hairline under it, so it read as a band of
   * chrome with the note starting below — and once the frame's top bar and the
   * status bar were counted, that was three horizontal rules stacked down one
   * window. The frame separates its regions by *value* now
   * (`chromeSurface`/`pageSurface`, see `tokens.ts`), and this sits on the
   * page, so a fill of its own would be a fourth surface and the rule would be
   * drawing a boundary that is not there.
   *
   * `paddingHorizontal` is gone with them: `BrowsePane` indents the crumb to
   * `noteGutterFor` so the path starts at the note's own first character,
   * which a fixed gutter cannot do — the column is centred and moves with the
   * width. The trailing actions are outside that padding and keep the
   * region's edge.
   *
   * The vertical padding grows, because a line with no rule under it needs the
   * air to separate it from the note instead.
   */
  /**
   * `‹ ›`, tight against each other and looser against the path.
   *
   * Its own row rather than two children of `bar`, so the 6pt gap between
   * crumbs does not also separate a pair that reads as one control.
   */
  history: {
    flexDirection: "row",
    alignItems: "center",
    // Room for a keyboard focus ring (3pt out, 2pt wide) around one arrow
    // without it drawing over the other.
    gap: 6,
    marginRight: 2,
  },
  step: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  stepHover: { backgroundColor: colors.surface2 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: space.x4,
    paddingBottom: space.x2,
    paddingRight: space.x4,
    backgroundColor: "transparent",
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
  context: { color: colors.text2, fontSize: t.label },
  separator: { color: colors.heroDim, fontSize: t.label },
  /**
   * The folder segment's own visual box — `layout.crumbSegmentHeight` tall (an
   * 11px mono label inside 1pt of vertical padding, 22.15pt), on **every**
   */
  segment: { paddingHorizontal: 3, paddingVertical: 1, borderRadius: radii.xs },
  segmentHover: { backgroundColor: colors.surface3 },
  folder: { color: colors.muted, fontSize: t.label },
  leaf: { color: colors.text, fontSize: t.label },
  /**
   * The note's own name, at the size a title is read at.
   *
   * 11px is right for the trailing segment of a path in a bar that also carries
   * a tab strip and a tree; on a phone this line is the only thing naming what
   * is on screen, and the folders in front of it are the supporting detail
   * rather than the other way round.
   */
  leafCompact: { fontSize: t.ui, fontWeight: "600" },
  spacer: { flex: 1, minWidth: space.x3 },

});
