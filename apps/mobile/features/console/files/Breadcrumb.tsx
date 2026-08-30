import { Fragment } from "react";
import { StyleSheet, View, useWindowDimensions } from "react-native";
import { densityFor } from "../../app/frame";
import { PressRow } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { colors, fonts, radii, space } from "../../design/tokens";
import { baseName } from "./paths";
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
 * ## The segments are real navigation
 *
 * Each folder is pressable and selects that folder, which is what a breadcrumb
 * is *for* — a path you can only read is a label. The last segment, the note
 * itself, is not: pressing it would re-select what you are already looking at.
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
 */
export function Breadcrumb({
  path,
  contextLabel,
  visibility,
  inherited,
  exception,
  readOnly,
  onSelectFolder,
}: {
  path: string;
  /** "@seyi" — the context is the first segment, and it is the product's root. */
  contextLabel: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
  onSelectFolder?: (folder: string) => void;
}) {
  const segments = path.split("/").filter((segment) => segment !== "");
  const folders = segments.slice(0, -1);
  const compact = densityFor(useWindowDimensions().width) === "compact";

  return (
    <View style={[styles.bar, compact && styles.barCompact]}>
      {compact ? null : (
        <Text variant="mono" style={styles.context} numberOfLines={1}>
          {contextLabel}
        </Text>
      )}

      {folders.map((segment, index) => {
        const folder = segments.slice(0, index + 1).join("/");
        return (
          <Fragment key={folder}>
            {/*
              A separator joins two things. With the context segment dropped at
              `compact` there is nothing to the left of the first folder, and an
              unconditional one renders the path as "/ 1-projects / note" — a
              leading slash that reads as an absolute path into the bucket root,
              which is precisely the addressing this product does not use.
            */}
            {compact && index === 0 ? null : <Separator />}
            <PressRow
              accessibilityLabel={`Open ${folder}`}
              onPress={() => onSelectFolder?.(folder)}
              radius={radii.xs}
              style={styles.segment}
              hoverStyle={styles.segmentHover}
            >
              <Text variant="mono" style={styles.folder} numberOfLines={1}>
                {segment}
              </Text>
            </PressRow>
          </Fragment>
        );
      })}

      {compact && folders.length === 0 ? null : <Separator />}
      <Text
        variant="mono"
        style={[styles.leaf, compact && styles.leafCompact]}
        numberOfLines={1}
      >
        {baseName(path)}
      </Text>

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

function Separator() {
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

const styles = StyleSheet.create({
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
    paddingHorizontal: space.x5,
    paddingTop: 0,
    paddingBottom: space.x2,
    borderBottomWidth: 0,
    backgroundColor: "transparent",
  },
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
