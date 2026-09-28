/**
 * The cells a List row is drawn from, beside its name (`TaskRow.tsx`): the
 * priority mark (a button for somebody who may write), the tags, the status
 * value, the owner, the hover tools, and a phone's second line.
 *
 * **The name takes the room** (the owner, 2026-09-28: "the spacing here got
 * all the way messed up, I cant even read the tasks"). A row is a name that
 * grows and never goes below `NAME_MIN`, with its progress ("0 of 4 done")
 * beside it on one line, and after it only compact cells: the first tag or
 * two, which give way first, the due day, and the owner, whose name gives
 * way to its face. What only matters under the pointer — Open, "+ Subtask",
 * the status value — lies over the end of the name while the row is hovered
 * or one of them has the keyboard (`RowTools`), rather than keeping a column
 * of empty space on every row whether it is hovered or not.
 */

import { useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Menu } from "../../../design/components/Menu";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { OwnerFace, PriorityGlyph, type Face } from "./Glyphs";
import { ownerChoiceFor, ownerLabel, type ItemActions } from "./items";
import { NEW_FRONT_NOTE, type FolderItem } from "./model";
import { PropertyValue } from "./PropertyValue";
import { ownersOf, priorityWord, tagsOf, type Priority } from "./taskProps";
import { PRIORITIES } from "./tasks/taskWords";

/** Tags drawn on a row before the rest are counted. */
const TAGS_SHOWN = 1;
/** The least a name keeps: the cells after it give way before it does. */
export const NAME_MIN = 140;

/**
 * Whether the pointer is over a row, and the props that say so.
 *
 * Not the row `Pressable`'s own `onHoverIn`: react-native-web hands hover to
 * the innermost pressable, so the row stopped being hovered the moment the
 * pointer reached one of its own controls — Open, "+ Subtask", the status —
 * and they vanished from under it. On the web the row's element listens for
 * the pointer entering and leaving it, which its children do not interrupt.
 */
export function useRowHover(): [boolean, Record<string, unknown>] {
  const [hovered, setHovered] = useState(false);
  if (Platform.OS !== "web") return [hovered, { onHoverIn: () => setHovered(true), onHoverOut: () => setHovered(false) }];
  return [
    hovered,
    {
      onPointerEnter: (event: { nativeEvent?: { pointerType?: string } }) => {
        if (event.nativeEvent?.pointerType !== "touch") setHovered(true);
      },
      onPointerLeave: () => setHovered(false),
    },
  ];
}

/** The priority choices, Urgent first, each with its mark: the right-click menu's words. */
export function priorityChoices(current: Priority | null) {
  return [
    ...PRIORITIES.map((id, at) => ({
      id: id as string,
      label: priorityWord(at as Priority),
      checked: current === at,
      leading: <PriorityGlyph priority={at as Priority} />,
    })),
    { id: "none", label: priorityWord(null), checked: current === null, leading: <PriorityGlyph priority={null} /> },
  ];
}

/**
 * The row's priority: its mark, and for somebody who may write a button that
 * opens the choices under it (`onChoose(item, "priority", …)`, the row's own
 * write road, said with an Undo). A member sees the mark alone.
 */
export function PriorityCell({ item, actions }: { item: FolderItem; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const node = useRef<View>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null | undefined>(undefined);
  const edit = actions.onChoose;
  if (edit === null) return <PriorityGlyph priority={item.priority} />;
  const open = anchor !== undefined;
  return (
    <View ref={node} collapsable={false}>
      <Pressable
        onPress={() => {
          setAnchor(null);
          node.current?.measureInWindow?.((x, y, _width, height) => setAnchor({ x, y: y + height + 4 }));
        }}
        role="button"
        aria-haspopup="menu"
        aria-expanded={open}
        accessibilityLabel={`Change priority, ${priorityWord(item.priority)}`}
        hitSlop={6}
        style={styles.priority}
        testID="folder-item-priority"
      >
        <PriorityGlyph priority={item.priority} />
      </Pressable>
      {open ? (
        <Menu<string>
          items={priorityChoices(item.priority)}
          {...(anchor === null ? {} : { anchor })}
          title="Priority"
          onDismiss={() => setAnchor(undefined)}
          onSelect={(id) => {
            setAnchor(undefined);
            edit(item, "priority", id === "none" ? null : id);
          }}
        />
      ) : null}
    </View>
  );
}

/**
 * What only matters under the pointer, at the end of the name rather than
 * keeping a column of its own. Each tool keeps itself invisible until the row
 * is hovered or it has the keyboard, and only then does the name make room
 * for them (`useToolsRoom`): its text ends, with an ellipsis, where the tools
 * begin, so it is never drawn under them and a name at rest keeps it all.
 */
export function RowTools({ shown, room, children }: { shown: boolean; room?: ToolsRoom; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[styles.tools, (shown || room?.focused === true) && styles.toolsShown]}
      pointerEvents="box-none"
      onLayout={room === undefined ? undefined : (event: LayoutChangeEvent) => room.setWidth(Math.ceil(event.nativeEvent.layout.width))}
      // A tool keeps the focus a click gave it, and shows while it has it: the name makes room then too.
      {...(room === undefined ? {} : { onFocus: (event: unknown) => room.setFocused(keyboardFocus(event)), onBlur: () => room.setFocused(false) })}
      testID="folder-row-tools"
    >
      {children}
    </View>
  );
}

/**
 * Whether a focus is one the keyboard gave (`:focus-visible`). A button keeps
 * the focus a click gave it, and a tool shown for that stayed over the name
 * after the pointer had gone; only a keyboard's focus shows a hover tool.
 */
export function keyboardFocus(event: unknown): boolean {
  const target = (event as { target?: { matches?: (selector: string) => boolean } } | null)?.target;
  if (Platform.OS !== "web" || typeof target?.matches !== "function") return true;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
}

export interface ToolsRoom {
  readonly focused: boolean;
  setWidth(width: number): void;
  setFocused(focused: boolean): void;
}

/**
 * The room a name gives its tools while they show — hovered, or one of them
 * holding the focus: its right padding, the tools' own measured width, so
 * the name's text is cut short of them. The tools lie at the name's right
 * edge whatever its padding.
 */
export function useToolsRoom(shown: boolean): [ViewStyle | null, ToolsRoom] {
  const [width, setWidth] = useState(0);
  const [focused, setFocused] = useState(false);
  return [(shown || focused) && width > 0 ? { paddingRight: width + space.x1 } : null, { focused, setWidth, setFocused }];
}

export function StatusValue({ item, actions, quiet, compact }: { item: FolderItem; actions: ItemActions; quiet: boolean; compact: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const edit = actions.onChoose;
  return (
    <PropertyValue
      property="status"
      value={item.status}
      choices={actions.choices("status")}
      sections={actions.statusMenu}
      onEditList={actions.onEditStatuses}
      savesTo={item.creates ? NEW_FRONT_NOTE : null}
      onChoose={edit === null ? null : (value) => edit(item, "status", value)}
      variant="tree"
      // The section already says it: a set status is the row's handle, shown when the row is.
      quiet={quiet}
      style={compact ? styles.cellMuted : styles.cellText}
      testID="folder-item-status"
    />
  );
}

function faceFor(actions: ItemActions, owner: string | undefined): Face {
  if (owner === undefined) return { kind: "nobody" };
  return actions.faceOf?.(owner) ?? { kind: "person", name: ownerLabel(actions.owners, owner) };
}

export function OwnerCell({ item, actions }: { item: FolderItem; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const owners = ownersOf(item.properties);
  const first = owners[0];
  const more = owners.length - 1;
  const edit = actions.onChoose;
  // A list of owners is shown, never offered as one choice: picking one would drop the rest.
  const editable = edit !== null && more <= 0;
  return (
    <View style={styles.owner}>
      <PropertyValue
        property="owner"
        value={first ?? ""}
        choices={actions.choices("owner")}
        {...(actions.owners === undefined ? {} : { owners: ownerChoiceFor(actions.owners, item.creates ? null : item.target) })}
        savesTo={item.creates ? NEW_FRONT_NOTE : null}
        onChoose={editable ? (value) => edit(item, "owner", value) : null}
        lead={<OwnerFace face={faceFor(actions, first)} />}
        unsetLabel="No owner"
        style={styles.cellText}
        testID="folder-item-owner"
      />
      {more > 0 ? (
        <Text variant="meta" style={styles.muted} accessibilityLabel={`and ${more} more`} testID="folder-item-more-owners">
          {`+${more}`}
        </Text>
      ) : null}
    </View>
  );
}

export function Tags({ tags }: { tags: readonly string[] }) {
  const styles = useThemedStyles(makeStyles);
  // Drawn empty too, so the next cells stay in their columns.
  if (tags.length === 0) return <View style={styles.tags} />;
  const rest = tags.length - TAGS_SHOWN;
  return (
    <View style={styles.tags} testID="folder-item-tags">
      {tags.slice(0, TAGS_SHOWN).map((tag) => (
        <Text key={tag.toLowerCase()} variant="meta" numberOfLines={1} style={styles.tag}>
          {isolateForDisplay(tag)}
        </Text>
      ))}
      {rest > 0 ? (
        <Text variant="meta" numberOfLines={1} style={styles.more}>
          {`+${rest}`}
        </Text>
      ) : null}
    </View>
  );
}

/** On a phone the columns go, and who and when move under the name. */
export function CompactLine({ item, due, actions }: { item: FolderItem; due: string; actions: ItemActions }) {
  const styles = useThemedStyles(makeStyles);
  const owners = ownersOf(item.properties);
  const who = owners.length === 0 ? null : ownerLabel(actions.owners, owners[0]!) + (owners.length > 1 ? ` +${owners.length - 1}` : "");
  const tags = tagsOf(item.properties);
  const parts = [who, due === "" ? null : due, tags.length === 0 ? null : tags.map((tag) => isolateForDisplay(tag)).join(", ")];
  const line = parts.filter((part): part is string => part !== null).join(" · ");
  return line === "" ? null : (
    <Text variant="meta" numberOfLines={1} style={styles.sub}>
      {line}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    priority: { borderRadius: radii.sm, padding: 2, margin: -2 },
    tools: {
      position: "absolute",
      top: 0,
      bottom: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingLeft: space.x2,
    },
    // Behind the tools while they show: the row's hover tint, so they read as part of it.
    toolsShown: { backgroundColor: colors.surface3 },
    muted: { color: colors.chromeMuted },
    more: { flexShrink: 0, color: colors.chromeMuted },
    sub: { color: colors.muted },
    // The first cell to give way: its chips shorten, then it narrows to nothing before the name does.
    tags: { flexDirection: "row", alignItems: "center", gap: space.x1, width: 104, flexShrink: 1, minWidth: 0, overflow: "hidden" },
    tag: {
      flexShrink: 1,
      minWidth: 0,
      color: colors.muted,
      backgroundColor: colors.chipFill,
      borderRadius: radii.sm,
      paddingHorizontal: space.x2,
      paddingVertical: 2,
    },
    // A column, so faces line up; when room runs out the name gives way to the face.
    owner: { flexDirection: "row", alignItems: "center", gap: space.x1, width: 120, flexShrink: 1, minWidth: 28, overflow: "hidden" },
    cellText: { color: colors.text2 },
    cellMuted: { color: colors.muted },
  });
