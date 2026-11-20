/**
 * "Tex in this note": the log of Tex's runs in one note, drawn under the note's
 * body. What each run did, who asked, and whether it ran with somebody's own
 * access. The rows are the gateway's (`fetchNoteRuns`); this draws them and
 * decides nothing about them.
 */

import { StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { NoteRunRow } from "./contract";
import { emptyLogSentence } from "./noteRun";

/** The colour of someone who is not the viewer: the mock's purple. */
const OTHER_AVATAR = "#6A46B8";

export function TexInNoteLog({
  rows,
  error,
  viewer,
  gutter = 0,
}: {
  rows: readonly NoteRunRow[];
  /** A sentence for why the log could not be read; shown instead of the rows. */
  error: string | null;
  /** The viewer's `@handle`, whose rows take the accent colour. */
  viewer: string | null;
  /** The note's reading margin, so the log lines up with the text above it. */
  gutter?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={[styles.section, { paddingHorizontal: gutter }]} testID="tex-in-note-log">
      <View style={styles.heading}>
        <Icon name="sparkle" size={14} color={colors.muted} />
        <Text variant="meta" style={styles.headingText}>
          Tex in this note
        </Text>
      </View>
      {error !== null ? (
        <Text variant="meta" style={styles.empty} testID="tex-in-note-error">
          {error}
        </Text>
      ) : rows.length === 0 ? (
        <Text variant="meta" style={styles.empty} testID="tex-in-note-empty">
          {emptyLogSentence(isMacPlatform())}
        </Text>
      ) : (
        rows.map((row) => <LogRow key={row.runId} row={row} viewer={viewer} accent={colors.accent} styles={styles} />)
      )}
    </View>
  );
}

function LogRow({
  row,
  viewer,
  accent,
  styles,
}: {
  row: NoteRunRow;
  viewer: string | null;
  accent: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  const name = row.who.replace(/^@/, "");
  const mine = viewer !== null && sameHandle(row.who, viewer);
  const initial = name.charAt(0).toUpperCase() || "?";
  return (
    <View style={styles.row} testID="tex-in-note-row">
      <View style={[styles.avatar, { backgroundColor: mine ? accent : OTHER_AVATAR }]}>
        <Text variant="meta" style={styles.avatarText}>
          {initial}
        </Text>
      </View>
      <View style={styles.body}>
        <Text variant="meta" style={styles.line}>
          <Text variant="meta" style={styles.who}>
            {name}
          </Text>
          {` asked Tex: “${row.ask}”`}
        </Text>
        <Text variant="meta" style={styles.out}>
          {row.out}
        </Text>
        {row.sources.length > 0 ? (
          <View style={styles.sources}>
            {row.sources.map((source, index) => (
              <Text key={`${index}-${source}`} variant="meta" style={styles.source}>
                {source}
              </Text>
            ))}
          </View>
        ) : null}
        <Text variant="meta" style={styles.priv}>
          {row.private ? `Ran with ${name}'s access.` : "Lives with this note. Not added to your Tex chat."}
        </Text>
      </View>
    </View>
  );
}

/** `@Sayo` and `sayo` are the same person. */
function sameHandle(a: string, b: string): boolean {
  return a.replace(/^@/, "").toLowerCase() === b.replace(/^@/, "").toLowerCase();
}

/** The platform's own shortcut key: ⌘ on Apple devices, Ctrl elsewhere. */
function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? "");
}

const makeStyles = (c: Colors) =>
  StyleSheet.create({
    section: { marginTop: 24, paddingTop: 14, paddingBottom: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line },
    heading: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
    headingText: { color: c.text, fontSize: 13, fontWeight: "600" },
    empty: { color: c.muted, fontSize: 12.5, lineHeight: 18 },
    row: { flexDirection: "row", gap: 10, paddingVertical: 8 },
    avatar: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center", marginTop: 1 },
    avatarText: { color: "#fff", fontSize: 11, fontWeight: "600" },
    body: { flex: 1, minWidth: 0, gap: 3 },
    line: { color: c.text2, fontSize: 13, lineHeight: 18 },
    who: { color: c.text, fontWeight: "600" },
    out: { color: c.text, fontSize: 13, lineHeight: 18 },
    sources: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
    source: {
      color: c.muted,
      fontSize: 11,
      backgroundColor: c.surface3,
      borderRadius: 5,
      paddingHorizontal: 6,
      paddingVertical: 1,
      overflow: "hidden",
    },
    priv: { color: c.muted, fontSize: 11.5, marginTop: 3 },
  });
