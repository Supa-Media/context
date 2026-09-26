import { useState } from "react";
import { View } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import { describe as describeVisibility } from "../Breadcrumb";
import type { Property } from "../frontmatter";
import type { Visibility } from "../types";
import { propertyRows, type PropertyRow } from "./propertyEdit";
import { AddProperty, EditableProperty, type SetProperty } from "./PropertyFields";
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
 * ## It edits in place, one line at a time
 *
 * It was a reader, and the argument was sound: a writer that misunderstands a
 * line rewrites somebody's note into something they did not type. But with
 * the frontmatter hidden in the editor until the caret finds it, and not in a
 * phone's buffer at all, "edit the file instead" meant properties could not be
 * edited by anyone who did not already know where the YAML was.
 *
 * So values change here, through `setNoteProperty` — the write a folder list
 * already uses for a status — which changes that key's one line, leaves every
 * other byte alone, and refuses when what it wrote would not read back as the
 * value given. `propertyEdit.ts` decides which rows it may touch: a nested
 * map's child or a list is still shown and still read-only, because the panel
 * cannot draw it faithfully enough to edit. The change goes through the
 * editor's own `onChange`, so it saves, merges and undoes like typing.
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
  onSet,
}: {
  frontmatter: string;
  /**
   * Changes one property of the note, or `undefined` where it cannot be
   * changed — a reader without edit access, or an activity list.
   */
  onSet?: SetProperty;
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
  const [problem, setProblem] = useState<string | null>(null);
  const rows = withVisibility(propertyRows(frontmatter), visibility);

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
          {rows.map((row, index) =>
            onSet !== undefined && isEditable(row) ? (
              <EditableProperty key={`${row.key}-${index}`} row={row} onSet={onSet} onError={setProblem} />
            ) : (
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
            ),
          )}

          {/* Obsidian's last row. Absent, not inert, for somebody who can only read. */}
          {onSet === undefined ? null : <AddProperty onSet={onSet} onError={setProblem} />}
          {problem === null ? null : (
            <Text variant="meta" style={styles.propertyError} role="alert" testID="note-properties-problem">
              {problem}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** The stated visibility row is never one; see `withVisibility`. */
function isEditable(row: Property): row is PropertyRow {
  return (row as PropertyRow).editable === true;
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
export function withVisibility<Row extends Property>(
  rows: Row[],
  visibility?: {
    visibility: Visibility;
    inherited: Visibility;
    exception: boolean;
    readOnly: boolean;
  },
): (Row | Property)[] {
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
