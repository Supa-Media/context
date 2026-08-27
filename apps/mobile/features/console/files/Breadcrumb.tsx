import { Fragment } from "react";
import { StyleSheet, View } from "react-native";
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

  return (
    <View style={styles.bar}>
      <Text variant="mono" style={styles.context} numberOfLines={1}>
        {contextLabel}
      </Text>

      {folders.map((segment, index) => {
        const folder = segments.slice(0, index + 1).join("/");
        return (
          <Fragment key={folder}>
            <Separator />
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

      <Separator />
      <Text variant="mono" style={styles.leaf} numberOfLines={1}>
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
          {describe({ visibility, inherited, exception, readOnly })}
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
 */
export function describe({
  visibility,
  inherited,
  exception,
  readOnly,
}: {
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  readOnly: boolean;
}): string {
  if (readOnly) return "the access map";
  if (exception) return `${visibility} — set on this note`;
  return `${inherited} — follows its folder`;
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
  context: { color: colors.text2, fontSize: 11 },
  separator: { color: colors.heroDim, fontSize: 11 },
  segment: { paddingHorizontal: 3, paddingVertical: 1, borderRadius: radii.xs },
  segmentHover: { backgroundColor: colors.surface3 },
  folder: { color: colors.muted, fontSize: 11 },
  leaf: { color: colors.text, fontSize: 11 },
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
