import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../../design/components/Icon";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MenuItem } from "../../menuItem";
import type { FolderListSource } from "../../listBlock/model";
import { OwnerFace, PriorityGlyph, StatusDot } from "../../folderPage/Glyphs";
import { OwnerPicker } from "../../folderPage/OwnerPicker";
import { groupOfStatus, statusMenu, type StatusList } from "../../folderPage/statuses";
import { ESTIMATES, ESTIMATE_HINTS, priorityWord } from "../../folderPage/taskProps";
import { DuePanel, TagPanel } from "../../folderPage/tasks/QuickAddParts";
import { DUE_PRESET_LABELS, PRIORITIES, duePreset, type DuePreset } from "../../folderPage/tasks/taskWords";
import {
  CHIP_NAMES,
  chipWrite,
  isFresh,
  noteChips,
  withOwner,
  withTag,
  type ChipKey,
  type SetChip,
} from "./chipModel";
import { useStatusList } from "./useStatusList";

/** The whole note changed by `change`; why not, or null once it is in the draft. */
export type ChipEdit = (change: (current: string) => { text: string } | { error: string }) => string | null;

type Anchor = { x: number; y: number };
type Open =
  | { kind: "menu"; items: MenuItem<string>[]; title: string; anchor: Anchor | undefined }
  | { kind: "owner"; anchor: Anchor | null }
  | { kind: "tags" }
  | { kind: "due" };

/**
 * The note's common properties as chips under its name — board B of
 * `property-dropdown`, which the owner picked on 2026-10-14.
 *
 * A property the note has is a solid chip reading its value; pressing it opens
 * that property's list again, with a way to take it off. One it does not have
 * is a faint outline — Status, Owner, Priority, Due date, and More for the
 * rest — and pressing it adds it through the same list. Each pick is one
 * front matter line written through the editor's own `onChange` (`ChipEdit`,
 * the Properties card's road), so it saves, merges and undoes like typing; a
 * note with no front matter gets a block on the first pick.
 *
 * **When the faint ones show.** On a new note, always: that is the note this
 * was asked for. Otherwise under a pointer only while it is over the name or
 * the chips (`revealed`), so a note that is being read is not trailed by a
 * row of controls. A thumb has no hover, so a written-in note on a phone
 * gives the unset ones one quiet "Add property" chip instead.
 *
 * **Only in the Projects folder** (`tracks`; owner, 2026-10-18, board A of
 * `loose-note-chips`). Status, Owner, Priority and Due date are for tracking
 * work, so a loose note — anywhere outside the folder doing the Projects job —
 * offers none of them. A value it already has is still a solid chip. Under a
 * pointer the one "Add property" chip waits for the hover; on a phone there is
 * nothing over the name at all, and ••• → Add property is the way in
 * (`addPropertyAsk.ts`).
 *
 * A reader who may not edit sees the solid chips and nothing to press.
 */
export function PropertyChips({
  text,
  path,
  now,
  edit,
  source,
  touch,
  revealed,
  tracks,
  onOther,
}: {
  text: string;
  path: string;
  now: number;
  /** Undefined where the note can't be changed here. */
  edit: ChipEdit | undefined;
  /** Where the folder's statuses and the workspace's people are read. */
  source: FolderListSource | undefined;
  /** No hover: a phone, or the native app. */
  touch: boolean;
  /** The pointer is over the name or the chips. */
  revealed: boolean;
  /** The note is in the Projects folder, where the task properties are offered. */
  tracks: boolean;
  /** "Other property…" under More: the Properties card's own Add row. */
  onOther?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const statuses = useStatusList(path, source);
  const [open, setOpen] = useState<Open | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const chips = noteChips(text, now);
  const fresh = isFresh(text);
  const writable = edit !== undefined;

  const write = (key: ChipKey, value: string | readonly string[] | null) => {
    if (edit === undefined) return;
    setProblem(edit((current) => chipWrite(current, key, value)));
  };
  const writeWith = (key: ChipKey, value: (current: string) => string | readonly string[] | null) => {
    if (edit === undefined) return;
    setProblem(edit((current) => chipWrite(current, key, value(current))));
  };

  const choose = (key: ChipKey, anchor: Anchor | undefined) => {
    setProblem(null);
    if (key === "owner") {
      if (source?.searchOwners === undefined) {
        setProblem("People can’t be looked up here.");
        return;
      }
      setOpen({ kind: "owner", anchor: anchor ?? null });
    } else if (key === "tags") setOpen({ kind: "tags" });
    else setOpen({ kind: "menu", items: valueItems(key, chips.set, statuses, now), title: CHIP_NAMES[key], anchor });
  };

  const moreItems = (keys: readonly ChipKey[]): MenuItem<string>[] => [
    ...keys.map((key) =>
      key === "owner" || key === "tags"
        ? { id: `open:${key}`, label: CHIP_NAMES[key] }
        : { id: `open:${key}`, label: CHIP_NAMES[key], items: valueItems(key, chips.set, statuses, now) },
    ),
    ...(onOther === undefined ? [] : [{ id: "other", label: "Other property…", separatorBefore: keys.length > 0 }]),
  ];

  const select = (id: string, anchor: Anchor | undefined) => {
    setOpen(null);
    const [verb, key, ...rest] = id.split(":");
    const value = rest.join(":");
    if (verb === "other") onOther?.();
    else if (verb === "open") choose(key as ChipKey, anchor);
    else if (verb === "clear") write(key as ChipKey, null);
    else if (verb === "pick") setOpen({ kind: "due" });
    else if (verb === "preset") write("due", duePreset(value as DuePreset, new Date(now)));
    else if (verb === "set") write(key as ChipKey, value);
  };

  // The faint chips: on their own in a project, else folded into one, which a phone's loose note does not draw.
  const folded = !tracks || (touch && !fresh);
  const offered = tracks || !touch;
  const showUnset = writable && (tracks ? fresh || revealed || open !== null || touch : revealed || open !== null);
  const unset = folded || !writable ? [] : chips.unset;
  const more = folded ? [...chips.unset, ...chips.more] : chips.more;

  if (chips.set.length === 0 && (!writable || !offered)) return null;

  return (
    <View style={styles.wrap} testID="note-chips">
      <View style={styles.row}>
        {chips.set.map((chip) => (
          <Chip
            key={chip.key}
            solid
            tags={chip.key === "tags"}
            label={chip.label}
            lead={leadFor(chip.key, chip, statuses, colors)}
            accessibilityLabel={writable ? `Change ${CHIP_NAMES[chip.key].toLowerCase()}, ${chip.label}` : `${CHIP_NAMES[chip.key]}, ${chip.label}`}
            onPress={writable ? (anchor) => choose(chip.key, anchor) : undefined}
            testID={`note-chip-${chip.key}`}
          />
        ))}
        {unset.map((key) => (
          <Chip
            key={key}
            label={CHIP_NAMES[key]}
            hidden={!showUnset}
            lead={leadFor(key, null, statuses, colors)}
            accessibilityLabel={`Add ${CHIP_NAMES[key].toLowerCase()}`}
            onPress={(anchor) => choose(key, anchor)}
            testID={`note-chip-add-${key}`}
          />
        ))}
        {writable && offered && (more.length > 0 || onOther !== undefined) ? (
          <Chip
            label={folded ? "Add property" : "More"}
            hidden={!showUnset}
            lead={<Icon name="plus" size={12} color={colors.chromeMuted} />}
            accessibilityLabel={folded ? "Add a property" : "More properties"}
            onPress={(anchor) => setOpen({ kind: "menu", items: moreItems(more), title: "Add property", anchor })}
            testID="note-chip-more"
          />
        ) : null}
      </View>
      {open?.kind === "tags" ? (
        <TagPanel
          suggestions={[]}
          onAdd={(tag) => writeWith("tags", (current) => withTag(current, tag))}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "due" ? (
        <DuePanel
          now={new Date(now)}
          onPick={(day) => {
            setOpen(null);
            write("due", day);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {problem === null ? null : (
        <Text variant="meta" style={styles.problem} role="alert" testID="note-chips-problem">
          {problem}
        </Text>
      )}
      {open?.kind === "menu" ? (
        <Menu<string>
          items={open.items}
          {...(open.anchor === undefined ? {} : { anchor: open.anchor })}
          title={open.title}
          onDismiss={() => setOpen(null)}
          onSelect={(id) => select(id, open.anchor)}
        />
      ) : null}
      {open?.kind === "owner" && source?.searchOwners !== undefined ? (
        <OwnerPicker
          current=""
          search={source.searchOwners}
          prefer={[]}
          anchor={open.anchor}
          savesTo={null}
          onChoose={(owner) => {
            setOpen(null);
            if (owner === null) write("owner", null);
            else writeWith("owner", (current) => withOwner(current, owner));
          }}
          onDismiss={() => setOpen(null)}
        />
      ) : null}
    </View>
  );
}

/** The list one property offers, with a way off it when the note has it. */
export function valueItems(key: ChipKey, set: readonly SetChip[], statuses: StatusList, now: number): MenuItem<string>[] {
  const current = set.find((chip) => chip.key === key)?.raw ?? null;
  const clear = (label: string): MenuItem<string>[] =>
    current === null ? [] : [{ id: `clear:${key}`, label, separatorBefore: true }];
  switch (key) {
    case "status": {
      const items: MenuItem<string>[] = [];
      statusMenu(statuses).forEach((section, at) => {
        const words = section.words.filter((word) => word !== "");
        if (words.length === 0) return;
        items.push({ id: `head:${at}`, label: section.label, disabled: true, separatorBefore: items.length > 0 });
        for (const word of words) {
          items.push({ id: `set:status:${word}`, label: isolateForDisplay(word), checked: current?.toLowerCase() === word.toLowerCase() });
        }
      });
      return [...items, ...clear("No status")];
    }
    case "priority":
      return [
        ...PRIORITIES.map((id, at) => ({ id: `set:priority:${id}`, label: priorityWord(at as 0 | 1 | 2 | 3), checked: current === id })),
        ...clear("No priority"),
      ];
    case "estimate":
      return [
        ...ESTIMATES.map((size) => ({ id: `set:estimate:${size}`, label: size, detail: ESTIMATE_HINTS[size], checked: current === size })),
        ...clear("No estimate"),
      ];
    case "due":
      return [
        ...(Object.keys(DUE_PRESET_LABELS) as DuePreset[]).map((id) => ({
          id: `preset:due:${id}`,
          label: DUE_PRESET_LABELS[id],
          checked: current !== null && current === duePreset(id, new Date(now)),
        })),
        { id: "pick:due", label: "Pick a date…" },
        ...clear("No due date"),
      ];
    case "owner":
    case "tags":
      return clear(key === "owner" ? "No owner" : "No tags");
  }
}

function leadFor(key: ChipKey, chip: SetChip | null, statuses: StatusList, colors: Colors): ReactNode {
  switch (key) {
    case "status":
      return <StatusDot tone={chip === null ? "not-started" : (groupOfStatus(chip.raw, statuses) ?? "unplaced")} />;
    case "owner":
      return <OwnerFace face={chip === null ? { kind: "nobody" } : { kind: "person", name: chip.raw }} size={14} />;
    case "priority":
      return <PriorityGlyph priority={chip === null ? null : (Number(chip.raw.slice(1)) as 0 | 1 | 2 | 3)} />;
    case "due":
      return <Icon name="calendar" size={12} color={chip === null ? colors.chromeMuted : colors.accentText} />;
    case "estimate":
      return <Icon name="sliders" size={12} color={chip === null ? colors.chromeMuted : colors.accentText} />;
    case "tags":
      return null;
  }
}

function Chip({
  label,
  lead,
  solid = false,
  tags = false,
  hidden = false,
  accessibilityLabel,
  onPress,
  testID,
}: {
  label: string;
  lead: ReactNode;
  solid?: boolean;
  tags?: boolean;
  hidden?: boolean;
  accessibilityLabel: string;
  /** Undefined for a value somebody may only read. */
  onPress?: (anchor: Anchor | undefined) => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const node = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  const look = [styles.chip, solid ? (tags ? styles.tags : styles.solid) : styles.faint, hovered && (solid ? styles.solidHover : styles.faintHover), hidden && styles.hidden];
  const words = (
    <Text numberOfLines={1} style={[styles.label, solid ? (tags ? styles.tagsText : styles.solidText) : styles.faintText, hovered && !solid && styles.faintTextHover]}>
      {isolateForDisplay(label)}
    </Text>
  );
  if (onPress === undefined) {
    return (
      <View style={look} accessibilityLabel={accessibilityLabel} testID={testID}>
        {lead}
        {words}
      </View>
    );
  }
  return (
    <View ref={node} collapsable={false}>
      <Pressable
        onPress={() => {
          const measure = node.current?.measureInWindow;
          if (measure === undefined) onPress(undefined);
          else node.current!.measureInWindow((x, y, _width, height) => onPress({ x, y: y + height + 4 }));
        }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="button"
        aria-haspopup="menu"
        accessibilityLabel={accessibilityLabel}
        // Out of the tab order and the pointer's way while it is not shown.
        disabled={hidden}
        style={look}
        testID={testID}
      >
        {lead}
        {words}
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x2 },
    row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, minHeight: 26 },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      height: 26,
      maxWidth: 280,
      paddingHorizontal: 10,
      borderRadius: radii.pill,
      borderWidth: 1,
      cursor: "pointer" as never,
    },
    solid: { backgroundColor: colors.accentDim, borderColor: "transparent" },
    solidHover: { borderColor: colors.accent },
    tags: { backgroundColor: colors.chipFill, borderColor: "transparent" },
    faint: { borderColor: colors.lineStrong, borderStyle: "dashed", backgroundColor: "transparent" },
    faintHover: { borderStyle: "solid", backgroundColor: colors.surface3 },
    hidden: { opacity: 0 },
    label: { fontFamily: fonts.body, fontSize: pointerType.ui, lineHeight: 18, flexShrink: 1 },
    solidText: { color: colors.accentText, fontWeight: "600" },
    tagsText: { color: colors.muted },
    faintText: { color: colors.chromeMuted },
    faintTextHover: { color: colors.text },
    problem: { color: colors.critText },
  });
