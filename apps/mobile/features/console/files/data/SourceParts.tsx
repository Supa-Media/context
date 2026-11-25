/**
 * The parts of a source's folder page (boards 07, 09 and 10): the files it
 * holds, its settings as about.md has them, its keys by name, the call that
 * sends a row, and a few of a sheet's latest rows.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { fonts, pointerType, radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { CopyGlyph, FileGlyph, LockGlyph, SheetGlyph } from "./Marks";
import type { Setting } from "./words";

export interface FileLine {
  readonly name: string;
  /** Where it opens; null for a dataset worked out on read, which is no file. */
  readonly path: string | null;
  readonly sheet: boolean;
  /** A sheet's columns, in mono: `repo, number, title`. */
  readonly columns?: string;
  /** A note's line: "Settings for this source, shown below". */
  readonly kind?: string;
  readonly rows?: string;
  readonly last?: string;
}

export function FileRows({ files, compact, onOpen }: { files: readonly FileLine[]; compact: boolean; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.files}>
      {files.map((file) => (
        <FileRow key={file.name} file={file} compact={compact} onOpen={onOpen} />
      ))}
    </View>
  );
}

function FileRow({ file, compact, onOpen }: { file: FileLine; compact: boolean; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [hovered, setHovered] = useState(false);
  const path = file.path;
  return (
    <Pressable
      role={path === null ? undefined : "link"}
      disabled={path === null}
      accessibilityLabel={file.name}
      onPress={path === null ? undefined : () => onOpen(path)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[styles.file, compact && styles.fileCompact, hovered && path !== null && styles.fileHover]}
      testID="data-file-row"
    >
      {file.sheet ? <SheetGlyph size={15} color={colors.chromeMuted} /> : <FileGlyph size={15} color={colors.chromeMuted} />}
      <Text style={[styles.fileName, compact && styles.fileNameCompact]} numberOfLines={1}>
        {file.name}
      </Text>
      {compact ? null : file.columns !== undefined ? (
        <Text style={styles.columns} numberOfLines={1}>
          {file.columns}
        </Text>
      ) : (
        <Text style={styles.kind} numberOfLines={1}>
          {file.kind ?? ""}
        </Text>
      )}
      <Text style={styles.rows} numberOfLines={1}>
        {file.rows ?? ""}
      </Text>
      {compact ? null : (
        <Text style={styles.last} numberOfLines={1}>
          {file.last ?? ""}
        </Text>
      )}
    </Pressable>
  );
}

/** Key and value rows, as a note's properties are drawn on the boards. */
export function PropsGrid({ rows, compact }: { rows: readonly { key: string; value: ReactNode; lock?: boolean }[]; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.props}>
      {rows.map((row) => (
        <View key={row.key} style={styles.propRow}>
          <View style={[styles.propKey, compact && styles.propKeyCompact]}>
            {row.lock === true ? <LockGlyph size={12} color={colors.chromeMuted} /> : null}
            <Text style={styles.keyText}>{row.key}</Text>
          </View>
          <View style={styles.propValue}>{row.value}</View>
        </View>
      ))}
    </View>
  );
}

export function Code({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.code}>{text}</Text>;
}

export function Words({ text, quiet = false, small = false }: { text: string; quiet?: boolean; small?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={[styles.words, quiet && styles.quiet, small && styles.small]}>{text}</Text>;
}

/** A source's settings: lists as code chips, the sign-in line with its lock and in muted words. */
export function SettingsGrid({ settings, compact }: { settings: readonly Setting[]; compact: boolean }) {
  return (
    <PropsGrid
      compact={compact}
      rows={settings.map((setting) => ({
        key: setting.key,
        lock: setting.signIn === true,
        value: setting.code ? (
          <>
            {setting.values.map((value) => (
              <Code key={value} text={value} />
            ))}
          </>
        ) : (
          <Words text={setting.values.join(", ")} quiet={setting.signIn === true} />
        ),
      }))}
    />
  );
}

export interface KeyLine {
  readonly id: string;
  readonly name: string;
  /** "Made Nov 3", or "Made by Seyi, Nov 3" where the maker is known. */
  readonly made: string;
  readonly rows: string;
  readonly used: string;
}

/** Keys by name, what each added and when it was last used: never the key. */
export function KeyList({ keys, onRevoke }: { keys: readonly KeyLine[]; onRevoke?: (id: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.keys}>
      {keys.map((key, at) => (
        <View key={key.id} style={[styles.key, at > 0 && styles.keyRule]} testID="data-key-row">
          <LockGlyph size={14} color={colors.text2} />
          <View style={styles.keyTitle}>
            <Text style={styles.keyName} numberOfLines={1}>
              {key.name}
            </Text>
            <Text style={styles.keyMade} numberOfLines={1}>
              {key.made}
            </Text>
          </View>
          <Text style={styles.keyCount}>{key.rows}</Text>
          <Text style={styles.keyCount}>{key.used}</Text>
          {onRevoke === undefined ? null : (
            <Pressable role="button" accessibilityLabel={`Revoke ${key.name}`} onPress={() => onRevoke(key.id)} style={styles.revoke}>
              <Text style={styles.revokeText}>Revoke</Text>
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

/** The call that sends a row, with Copy: `$CONTEXT_KEY` in place of any key. */
export function CodeBlock({ lines, onCopy }: { lines: readonly ReactNode[]; onCopy?: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.codeBlock}>
      {lines.map((line, at) => (
        <Text key={at} style={styles.codeLine}>
          {line}
        </Text>
      ))}
      {onCopy === undefined ? null : (
        <Pressable role="button" accessibilityLabel="Copy" onPress={onCopy} style={styles.copy}>
          <CopyGlyph size={12} color={colors.text} />
          <Text style={styles.copyText}>Copy</Text>
        </Pressable>
      )}
    </View>
  );
}

/** A string in the snippet's green, and a command in the key blue. */
export function CodeString({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.codeString}>{text}</Text>;
}
export function CodeCommand({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.codeCommand}>{text}</Text>;
}

/** A few rows of a sheet, header shaded, numbers on the right. */
export function MiniTable({ columns, rows }: { columns: readonly { name: string; numeric: boolean }[]; rows: readonly (readonly string[])[] }) {
  const styles = useThemedStyles(makeStyles);
  const flex = (numeric: boolean, at: number) => (numeric ? styles.cellNumeric : at === 1 ? styles.cellWide : styles.cell);
  return (
    <View style={styles.mini}>
      <View style={[styles.miniRow, styles.miniHead]}>
        {columns.map((column, at) => (
          <Text key={column.name} style={[styles.miniTh, flex(column.numeric, at), column.numeric && styles.right]} numberOfLines={1}>
            {column.name}
          </Text>
        ))}
      </View>
      {rows.map((row, r) => (
        <View key={r} style={[styles.miniRow, r < rows.length - 1 && styles.miniRule]}>
          {row.map((cell, at) => (
            <Text key={at} style={[styles.miniTd, flex(columns[at]?.numeric ?? false, at), columns[at]?.numeric === true && styles.right]} numberOfLines={1}>
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    files: { borderTopWidth: 1, borderTopColor: colors.line, marginBottom: 24 },
    file: { flexDirection: "row", alignItems: "center", gap: 12, height: 44, borderBottomWidth: 1, borderBottomColor: colors.line, paddingHorizontal: 4 },
    fileCompact: { height: 44 },
    fileHover: { backgroundColor: colors.chipFill },
    fileName: { width: 210, flexShrink: 0, fontSize: pointerType.ui, lineHeight: 18, fontWeight: "600", color: colors.text },
    fileNameCompact: { width: undefined, flexGrow: 1, flexShrink: 1 },
    columns: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    kind: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    rows: { width: 90, flexShrink: 0, textAlign: "right", fontSize: pointerType.meta, lineHeight: 16, color: colors.text2 },
    last: { width: 116, flexShrink: 0, textAlign: "right", fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    props: { borderTopWidth: 1, borderTopColor: colors.line, marginBottom: 24 },
    propRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.line, minHeight: 34 },
    propKey: { width: 140, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 4 },
    propKeyCompact: { width: 104 },
    keyText: { fontSize: pointerType.meta, lineHeight: 20, color: colors.muted },
    propValue: { flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 4 },
    code: {
      fontFamily: fonts.mono,
      fontSize: pointerType.meta,
      lineHeight: 18,
      color: colors.text2,
      backgroundColor: colors.chipFill,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: radii.xs,
    },
    words: { fontSize: pointerType.ui, lineHeight: 20, color: colors.text },
    quiet: { color: colors.muted },
    small: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    keys: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden", backgroundColor: colors.cardSurface, marginBottom: 24 },
    key: { flexDirection: "row", alignItems: "center", gap: 12, height: 46, paddingHorizontal: 12 },
    keyRule: { borderTopWidth: 1, borderTopColor: colors.line },
    keyTitle: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    keyName: { fontSize: pointerType.ui, lineHeight: 17, fontWeight: "600", color: colors.text },
    keyMade: { fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    keyCount: { width: 120, textAlign: "right", fontSize: pointerType.meta, lineHeight: 16, color: colors.muted },
    revoke: { width: 56, alignItems: "flex-end" },
    revokeText: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "500", color: colors.critText },
    codeBlock: {
      backgroundColor: colors.cardSurface,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      paddingVertical: 12,
      paddingHorizontal: 14,
      marginBottom: 24,
      overflow: "hidden",
    },
    codeLine: { fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 19, color: colors.text2, whiteSpace: "pre" } as never,
    // Spelled out, not inherited: a nested Text would otherwise take the design Text's own face.
    codeString: { fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 19, color: colors.okText },
    codeCommand: { fontFamily: fonts.mono, fontSize: pointerType.meta, lineHeight: 19, color: colors.codeKey },
    copy: {
      position: "absolute",
      top: 8,
      right: 8,
      height: 26,
      paddingHorizontal: 10,
      borderRadius: radii.md,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.chipFill,
      borderWidth: 1,
      borderColor: colors.line,
    },
    copyText: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "600", color: colors.text },
    mini: { borderWidth: 1, borderColor: colors.line, borderRadius: radii.card, overflow: "hidden", marginBottom: 24 },
    miniRow: { flexDirection: "row", alignItems: "center", minHeight: 30, paddingHorizontal: 4 },
    miniHead: { backgroundColor: colors.surface2, borderBottomWidth: 1, borderBottomColor: colors.line },
    miniRule: { borderBottomWidth: 1, borderBottomColor: colors.line },
    miniTh: { fontSize: pointerType.meta, lineHeight: 16, fontWeight: "500", color: colors.text2, paddingHorizontal: 6 },
    miniTd: { fontSize: pointerType.meta, lineHeight: 16, color: colors.text, paddingHorizontal: 6 },
    cell: { width: 180, flexShrink: 0 },
    cellWide: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
    cellNumeric: { width: 90, flexShrink: 0 },
    right: { textAlign: "right" },
  });
