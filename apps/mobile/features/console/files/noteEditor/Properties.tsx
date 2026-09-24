import { useState } from "react";
import { View } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import { describe as describeVisibility } from "../Breadcrumb";
import { properties, type Property } from "../frontmatter";
import type { Visibility } from "../types";
import { makeStyles } from "./styles";

/**
 * The note's filing metadata, folded away.
 *
 * A captured note opens with a dozen lines of YAML — `captured:`, `source:`,
 * `trust:`, `sender-authenticated-by:` — and the editor draws the file, so on a
 * phone that block *was* the first screen. The note started below the fold. It
 * is not secret and it is occasionally worth reading, so it is collapsed rather
 * than hidden: one quiet row that says how many fields there are, and opens.
 *
 * The same shape Obsidian uses, and for the same reason.
 *
 * ## It is a reader, not a form
 *
 * The values are `Text`, not inputs, and there is nothing here that writes.
 * Editing frontmatter means editing the note, which is what the editor below is
 * for and where the buffer is still the file byte for byte. A property editor
 * would need a YAML *writer*, and `frontmatter.ts` argues at length why this
 * codebase should not have one: a reader that misunderstands a line shows it
 * oddly, and a writer that misunderstands the same line rewrites somebody's
 * note into something they did not type.
 *
 * Collapsed is the resting state on purpose. The whole complaint this answers
 * is that metadata was taking the reader's first screen, and a row that starts
 * open takes it back.
 */
export function Properties({
  frontmatter,
  visibility,
  gutter,
  compact,
}: {
  frontmatter: string;
  /** See `NoteEditor`'s prop of the same name. */
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  };
  /** Where the note's own first character is. See the call site. */
  gutter: number;
  /**
   * Whether this is the phone's row.
   *
   * It decides the target's height and nothing else. A thumb needs
   * `minTouchTarget`; a pointer does not, and a 44pt box around an 11pt label
   * was the tallest thing between the breadcrumb and the note — which on the
   * surface with the most room to spare is where the air is least welcome.
   */
  compact: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  const rows = withVisibility(properties(frontmatter), visibility);

  return (
    <View style={[styles.properties, { paddingLeft: gutter, paddingRight: gutter }]}>
      <PressRow
        accessibilityLabel={
          open
            ? `Hide this note's ${rows.length} properties`
            : `Show this note's ${rows.length} properties`
        }
        onPress={() => setOpen((current) => !current)}
        radius={radii.sm}
        style={[styles.propertiesHead, compact && styles.propertiesHeadTouch]}
        hoverStyle={styles.propertiesHover}
        testID="note-properties"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.muted} />
        <Text variant="treeMeta">
          {/*
            The count is the whole of what the collapsed row has to say. "1
            property" over "1 properties" because a note with a single field is
            common enough — a bare `updated:` — that the ungrammatical form
            would be on screen most days.
          */}
          {rows.length === 1 ? "1 property" : `${rows.length} properties`}
        </Text>
      </PressRow>

      {open ? (
        /*
          Obsidian's panel, drawn from the reference: a rounded, faintly tinted
          card; one row per field with a small leading mark; the key in muted
          ink in a fixed leading column; the value in ordinary ink, wrapping to
          as many lines as it needs. The card is what makes it read as a block
          of *metadata about* the note rather than as the first paragraph of it.
        */
        <View style={styles.propertyCard} testID="note-properties-open">
          {rows.map((row, index) => (
            <View key={`${row.key}-${index}`} style={styles.property}>
              {/*
                Obsidian draws a different mark per property *type* — a
                calendar for a date, lines for text. Frontmatter here has no
                types, so one neutral mark stands for "this row is a labelled
                value" and it is `aria-hidden` because the key beside it is
                already the name.
              */}
              <View style={styles.propertyMark}>
                <Icon name="filter" size={15} color={colors.muted} />
              </View>
              <Text variant="rowSub" style={styles.propertyKey} numberOfLines={1}>
                {row.key}
              </Text>
              <Text variant="rowSub" style={styles.propertyValue}>
                {row.value}
              </Text>
            </View>
          ))}

          {/*
            Obsidian's last row, and ours is deliberately inert.

            Adding a property means *writing* frontmatter, and `frontmatter.ts`
            argues at length why this codebase has a reader and no writer: a
            reader that misunderstands a line shows it oddly, and a writer that
            misunderstands the same line rewrites somebody's note into something
            they did not type. Until there is a writer with a byte-for-byte
            round-trip test behind it, this states where the capability will be
            rather than pretending to have it — and it says so out loud to a
            screen reader, because a control that is present and silently
            refuses is the defect this codebase keeps recording.

            It is drawn rather than dropped because the row is also the honest
            answer to "where do I edit these?" on a phone: the frontmatter is
            not in the editor's buffer at this density (see the `LiveEditor`
            call above), so somebody looking for it needs to be told, not left
            to conclude it is gone.
          */}
          <View style={[styles.property, styles.propertyAdd]} aria-disabled testID="note-properties-add">
            <View style={styles.propertyMark}>
              <Icon name="plus" size={15} color={colors.muted} />
            </View>
            <Text
              variant="rowSub"
              style={styles.propertyAddLabel}
              accessibilityLabel="Add a property. Not available yet — edit this note's frontmatter from a desktop browser or in Obsidian."
            >
              Add property — from a desktop, for now
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The frontmatter's rows, with the one the frontmatter cannot answer.
 *
 * `visibility` is a property of a note in every sense that matters to a
 * reader — it is what the breadcrumb's chip used to say, and it belongs in the
 * panel that lists what is filed about this note. What it must **not** come
 * from is the file: `ManifestNotice` says it plainly, and so does
 * `fileOps.ts` — a `visibility:` line inside a note changes nothing, because
 * `privacy.md` decides access. So a note that carries one has that row
 * *replaced* rather than shown alongside, and the panel never states two
 * different answers to "who can read this".
 *
 * Exported for its test: this is a claim about who can read somebody's note,
 * and "the row quietly stopped being added" is the kind of regression that is
 * invisible on screen until it matters.
 */
export function withVisibility(
  rows: Property[],
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  },
): Property[] {
  if (visibility === undefined) return rows;
  // The phone's wording, from `Breadcrumb`, so the two surfaces cannot come to
  // describe the same three cases differently — a note that merely follows a
  // `team` folder and a note deliberately shared as an exception have to stay
  // distinguishable wherever either is printed.
  const stated: Property = {
    key: "visibility",
    value: describeVisibility({ ...visibility, brief: true }),
  };
  const written = rows.findIndex((row) => row.key === "visibility");
  if (written === -1) return [stated, ...rows];
  return rows.map((row, index) => (index === written ? stated : row));
}
