/**
 * The top of a folder page: its title with the Files · List · Board switch
 * beside it, and — for a folder that is a project, or can become one — the
 * quiet property line and the first paragraph of its front note (spec A5).
 *
 * ## The property line
 *
 * `active · Seyi · priority high · updated 2h ago`: words separated by `·`,
 * no pills, no boxes, nothing drawn for an unset property. Status and owner
 * open the same choices a list's values do, for somebody who may write;
 * everybody else reads plain words. A plain folder shows just `Set status`
 * to a writer, which is how "do this" becomes a project in one press — and
 * the write goes to its front note, or creates `overview.md` when it has
 * none, which the menu says before anything is pressed.
 *
 * ## The switch
 *
 * Three words, the chosen one in the text colour and weight, the others
 * muted: the same segmented text the list filter popover uses for Rows, and
 * no pill. It sits on the title's own row so it costs no line of its own.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { shortWhen } from "../listBlock/words";
import { NEW_FRONT_NOTE, type FolderPageView, type FolderSummary } from "./model";
import type { StatusMenuSection } from "./statuses";
import { PropertyValue } from "./PropertyValue";
import type { OwnerChoice } from "./items";

const VIEWS: ReadonlyArray<{ view: FolderPageView; label: string }> = [
  { view: "files", label: "Files" },
  { view: "list", label: "List" },
  { view: "board", label: "Board" },
];

/** Shown after status and owner when set, as `priority high`. */
const QUIET_KEYS = ["priority", "due"];

export function ViewSwitch({
  view,
  onChange,
  compact,
}: {
  view: FolderPageView;
  onChange: (view: FolderPageView) => void;
  compact: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.switch} role="tablist" accessibilityLabel="Show this folder as" testID="folder-view-switch">
      {VIEWS.map(({ view: each, label }, index) => (
        <View key={each} style={styles.switchItem}>
          {index > 0 ? (
            <Text variant={compact ? "rowValueTouch" : "tree"} style={styles.dot} aria-hidden>
              {"·"}
            </Text>
          ) : null}
          <SwitchWord label={label} on={view === each} compact={compact} onPress={() => onChange(each)} testID={`folder-view-${each}`} />
        </View>
      ))}
    </View>
  );
}

function SwitchWord({ label, on, compact, onPress, testID }: { label: string; on: boolean; compact: boolean; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      role="tab"
      aria-selected={on}
      accessibilityLabel={label}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      hitSlop={compact ? 10 : 4}
      testID={testID}
    >
      <Text variant={compact ? "rowValueTouch" : "tree"} style={[styles.word, hovered && styles.wordHover, on && styles.wordOn]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function FolderHead({
  title,
  onOpenTitle,
  switcher,
  actions,
  children,
}: {
  title: string;
  /** Opens the front note; absent when there is none to open. */
  onOpenTitle?: () => void;
  switcher: ReactNode;
  /** After the switch: the website folder's Publish. */
  actions?: ReactNode;
  /** The property line, the lede, the visibility sentence. */
  children?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const heading = (
    <Text variant="noteTitle" role="heading" aria-level={2} style={[styles.title, hovered && styles.titleHover]}>
      {title}
    </Text>
  );
  return (
    <>
      <View style={styles.head}>
        <View style={styles.titleBox}>
          {onOpenTitle === undefined ? (
            heading
          ) : (
            <Pressable
              role="link"
              accessibilityLabel={`Open ${title}`}
              onPress={onOpenTitle}
              onHoverIn={() => setHovered(true)}
              onHoverOut={() => setHovered(false)}
              testID="folder-title-open"
            >
              {heading}
            </Pressable>
          )}
        </View>
        {switcher}
        {actions}
      </View>
      {children}
    </>
  );
}

export function PropertyLine({
  summary,
  compact,
  now,
  choices,
  statusMenu,
  owners,
  onChoose,
}: {
  summary: FolderSummary;
  compact: boolean;
  now: number;
  choices: (key: string) => readonly string[];
  /** The groups this folder's own status is chosen from: its parent's status list. */
  statusMenu?: readonly StatusMenuSection[];
  /** Where the owner is picked from; see `ItemActions.owners`. */
  owners?: OwnerChoice;
  /** Null for somebody who may not write. */
  onChoose: ((key: string, value: string | null) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const variant = compact ? "rowValueTouch" : "tree";
  const text = (key: string): string => {
    const raw = summary.properties[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value.trim() : "";
  };
  const status = text("status");
  const owner = text("owner");
  const savesTo = summary.creates ? NEW_FRONT_NOTE : null;
  const parts: ReactNode[] = [];
  const editable = (key: string, value: string) => (
    <PropertyValue
      key={key}
      property={key}
      value={value}
      choices={choices(key)}
      {...(key === "status" && statusMenu !== undefined ? { sections: statusMenu } : {})}
      {...(key === "owner" && owners !== undefined ? { owners } : {})}
      savesTo={savesTo}
      onChoose={onChoose === null ? null : (next) => onChoose(key, next)}
      variant={variant}
      style={styles.value}
      testID={`folder-property-${key}`}
    />
  );
  if (status !== "" || onChoose !== null) parts.push(editable("status", status));
  // Owner is offered once there is a status: a plain folder asks one question.
  if (owner !== "" || (onChoose !== null && status !== "")) parts.push(editable("owner", owner));
  for (const key of QUIET_KEYS) {
    const value = text(key);
    if (value !== "") {
      parts.push(
        <Text key={key} variant={variant} style={styles.value}>
          {`${key} ${isolateForDisplay(value)}`}
        </Text>,
      );
    }
  }
  if (status !== "" && summary.updatedAt !== null) {
    parts.push(
      <Text key="updated" variant={variant} style={styles.value}>
        {`updated ${shortWhen(summary.updatedAt, now)}`}
      </Text>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <View style={styles.line} testID="folder-property-line">
      {parts.map((part, index) => (
        <View key={index} style={styles.part}>
          {index > 0 ? (
            <Text variant={variant} style={styles.dot} aria-hidden>
              {"·"}
            </Text>
          ) : null}
          {part}
        </View>
      ))}
    </View>
  );
}

export function Lede({ text }: { text: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Text variant="body" numberOfLines={3} style={styles.lede} testID="folder-lede">
      {isolateForDisplay(text)}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    titleBox: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    title: { flexShrink: 1 },
    titleHover: { textDecorationLine: "underline" },
    switch: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
    switchItem: { flexDirection: "row", alignItems: "center" },
    word: { color: colors.chromeMuted },
    wordHover: { color: colors.text2 },
    wordOn: { color: colors.text, fontWeight: "600" },
    dot: { color: colors.chromeMuted, paddingHorizontal: 6 },
    line: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", rowGap: 2 },
    part: { flexDirection: "row", alignItems: "center" },
    value: { color: colors.text2 },
    lede: { color: colors.text2 },
  });
