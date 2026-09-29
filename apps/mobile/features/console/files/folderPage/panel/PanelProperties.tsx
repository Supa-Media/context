/**
 * A task's values in the side panel, each one press from changing: Status,
 * Priority, Estimate, Owners, Tags and Due, in the owner's words — Urgent to Low, never
 * `p0`; "Saturday, Oct 3", never `2026-10-03`.
 *
 * Every change is one frontmatter line of the task's own note, the write the
 * rows make (`write`). Owners are several, each with its face and a way to
 * take it off; a new one is picked from people and AI helpers, never typed.
 * Tags are free words, suggested from what the project already uses. A
 * member sees every value as words, with nothing to press.
 */

import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../../design/components/Icon";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { OwnerFace, PriorityGlyph, StatusDot } from "../Glyphs";
import { ownerChoiceFor, ownerLabel, type ItemActions } from "../items";
import { NEW_FRONT_NOTE, type FolderItem } from "../model";
import { OwnerPicker } from "../OwnerPicker";
import { PropertyValue } from "../PropertyValue";
import { faceFor } from "../taskFace";
import { dueOf, estimateOf, ESTIMATE_HINTS, NO_ESTIMATE, ownersOf, priorityWord, tagsOf } from "../taskProps";
import { estimateChoices } from "../EstimateCell";
import { DuePanel, TagPanel, type Anchor } from "../tasks/QuickAddParts";
import { DUE_PRESET_LABELS, PRIORITIES, duePreset, type DuePreset } from "../tasks/taskWords";
import { dueLong, ownersValue } from "./panelModel";

export type PanelWrite = (key: string, value: string | readonly string[] | null) => void;

type MenuKind = "priority" | "estimate" | "due" | "owner";

/** Tags are always written as a list, and none clears the line. */
const tagsValue = (tags: readonly string[]) => (tags.length === 0 ? null : [...tags]);

export function PanelProperties({
  item,
  target,
  actions,
  write,
  tagSuggestions,
  now,
}: {
  item: FolderItem;
  /** Where its values are written, for the owner picker's suggestion; null when that note is not there yet. */
  target: string | null;
  actions: ItemActions;
  /** Null for somebody who may not write. */
  write: PanelWrite | null;
  tagSuggestions: readonly string[];
  now: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [menu, setMenu] = useState<{ kind: MenuKind; anchor: Anchor } | null>(null);
  const [panel, setPanel] = useState<"tag" | "due" | null>(null);
  const owners = ownersOf(item.properties);
  const tags = tagsOf(item.properties);
  const due = dueOf(item.properties);
  const estimate = estimateOf(item.properties);
  const label = (owner: string) => isolateForDisplay(ownerLabel(actions.owners, owner));
  const open = (kind: MenuKind) => (anchor: Anchor) => setMenu({ kind, anchor });
  const suggest = actions.owners === undefined ? undefined : ownerChoiceFor(actions.owners, target).suggest;
  const today = new Date(now);
  return (
    <View style={styles.grid}>
      <Row label="Status" testID="task-panel-status">
        <PropertyValue
          property="status"
          value={item.status}
          choices={actions.choices("status")}
          sections={actions.statusMenu}
          onEditList={actions.onEditStatuses}
          savesTo={item.creates ? NEW_FRONT_NOTE : null}
          onChoose={write === null ? null : (value) => write("status", value)}
          lead={<StatusDot tone={actions.toneOf(item.status)} />}
          unsetLabel="No status"
          style={styles.value}
          {...(write === null ? {} : { testID: "task-panel-status-button" })}
        />
      </Row>
      <Row label="Priority" testID="task-panel-priority">
        <Value editable={write !== null} onOpen={open("priority")} label={`Change priority, ${priorityWord(item.priority)}`} testID="task-panel-priority-button">
          <PriorityGlyph priority={item.priority} />
          <Text variant="tree" style={styles.value}>
            {priorityWord(item.priority)}
          </Text>
        </Value>
      </Row>
      <Row label="Estimate" testID="task-panel-estimate">
        <Value
          editable={write !== null}
          onOpen={open("estimate")}
          label={estimate === null ? "Set an estimate" : `Change estimate, ${estimate}`}
          testID="task-panel-estimate-button"
        >
          <Text variant="tree" style={estimate === null ? styles.muted : styles.value}>
            {estimate === null ? NO_ESTIMATE : `${estimate} · ${ESTIMATE_HINTS[estimate].toLowerCase()}`}
          </Text>
        </Value>
      </Row>
      <Row label="Owners" testID="task-panel-owners">
        <View style={styles.wrap}>
          {owners.length === 0 ? (
            <View style={styles.chip}>
              <OwnerFace face={{ kind: "nobody" }} size={20} />
              <Text variant="tree" style={styles.muted}>
                No owner
              </Text>
            </View>
          ) : (
            owners.map((owner) => (
              <View key={owner.toLowerCase()} style={styles.chip}>
                <OwnerFace face={faceFor(actions, owner)} size={20} />
                <Text variant="tree" numberOfLines={1} style={styles.value}>
                  {label(owner)}
                </Text>
                {write === null ? null : (
                  <Remove
                    label={`Remove ${ownerLabel(actions.owners, owner)}`}
                    onPress={() => write("owner", ownersValue(owners.filter((each) => each !== owner)))}
                    testID="task-panel-owner-remove"
                  />
                )}
              </View>
            ))
          )}
          {write === null || actions.owners === undefined ? null : (
            <Value editable onOpen={open("owner")} label="Add an owner" testID="task-panel-owner-add">
              <Icon name="plus" size={14} color={colors.chromeMuted} />
            </Value>
          )}
        </View>
      </Row>
      <Row label="Tags" testID="task-panel-tags">
        <View style={styles.wrap}>
          {tags.length === 0 && write === null ? (
            <Text variant="tree" style={styles.muted}>
              No tags
            </Text>
          ) : null}
          {tags.map((tag) => (
            <View key={tag.toLowerCase()} style={[styles.chip, styles.tag]}>
              <Text variant="meta" numberOfLines={1} style={styles.tagText}>
                {isolateForDisplay(tag)}
              </Text>
              {write === null ? null : (
                <Remove label={`Remove tag ${tag}`} onPress={() => write("tags", tagsValue(tags.filter((each) => each !== tag)))} testID="task-panel-tag-remove" />
              )}
            </View>
          ))}
          {write === null ? null : (
            <Value editable onOpen={() => setPanel(panel === "tag" ? null : "tag")} label="Add a tag" testID="task-panel-tag-add">
              <Icon name="plus" size={14} color={colors.chromeMuted} />
            </Value>
          )}
        </View>
      </Row>
      {panel === "tag" && write !== null ? (
        <View style={styles.inline}>
          <TagPanel
            suggestions={tagSuggestions.filter((tag) => !tags.some((each) => each.toLowerCase() === tag.toLowerCase()))}
            onAdd={(tag) => {
              if (!tags.some((each) => each.toLowerCase() === tag.toLowerCase())) write("tags", [...tags, tag]);
            }}
            onClose={() => setPanel(null)}
          />
        </View>
      ) : null}
      <Row label="Due" testID="task-panel-due">
        <Value editable={write !== null} onOpen={open("due")} label={due === null ? "Set a due date" : `Change due date, ${dueLong(due, now)}`} testID="task-panel-due-button">
          <Text variant="tree" style={due === null ? styles.muted : styles.value}>
            {due === null ? "No due date" : dueLong(due, now)}
          </Text>
        </Value>
      </Row>
      {panel === "due" && write !== null ? (
        <View style={styles.inline}>
          <DuePanel
            now={today}
            onPick={(day) => {
              setPanel(null);
              write("due", day);
            }}
            onClose={() => setPanel(null)}
          />
        </View>
      ) : null}
      {menu === null || write === null ? null : menu.kind === "owner" ? (
        actions.owners === undefined ? null : (
          <OwnerPicker
            current=""
            search={actions.owners.search}
            prefer={actions.owners.prefer}
            {...(suggest === undefined ? {} : { suggest })}
            {...(actions.owners.addAgent === undefined ? {} : { onAddAgent: actions.owners.addAgent })}
            anchor={menu.anchor}
            savesTo={item.creates ? NEW_FRONT_NOTE : null}
            onChoose={(value) => write("owner", value === null ? null : ownersValue(owners.some((each) => each.toLowerCase() === value.toLowerCase()) ? owners : [...owners, value]))}
            onDismiss={() => setMenu(null)}
          />
        )
      ) : (
        <Menu<string>
          items={
            menu.kind === "estimate"
              ? estimateChoices(estimate)
              : menu.kind === "priority"
              ? [
                  ...PRIORITIES.map((id, at) => ({ id, label: priorityWord(at as 0 | 1 | 2 | 3), checked: item.priority === at })),
                  { id: "none", label: priorityWord(null), checked: item.priority === null },
                ]
              : [
                  ...(Object.keys(DUE_PRESET_LABELS) as DuePreset[]).map((id) => ({ id, label: DUE_PRESET_LABELS[id] })),
                  { id: "pick", label: "Pick a date…" },
                  ...(due === null ? [] : [{ id: "clear", label: "No due date", separatorBefore: true }]),
                ]
          }
          {...(menu.anchor === null ? {} : { anchor: menu.anchor })}
          title={menu.kind === "priority" ? "Priority" : menu.kind === "estimate" ? "Estimate" : "Due date"}
          onDismiss={() => setMenu(null)}
          onSelect={(id) => {
            const kind = menu.kind;
            setMenu(null);
            if (kind === "priority") write("priority", id === "none" ? null : id);
            else if (kind === "estimate") write("estimate", id === "none" ? null : id);
            else if (id === "pick") setPanel("due");
            else write("due", id === "clear" ? null : duePreset(id as DuePreset, today));
          }}
        />
      )}
    </View>
  );
}

function Row({ label, testID, children }: { label: string; testID: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text variant="tree" style={styles.key}>
        {label}
      </Text>
      <View style={styles.cell} testID={testID}>
        {children}
      </View>
    </View>
  );
}

/** A value that opens its menu under itself when pressed; plain words for somebody who may not write. */
function Value({
  editable,
  onOpen,
  label,
  testID,
  children,
}: {
  editable: boolean;
  onOpen: (anchor: Anchor) => void;
  label: string;
  testID: string;
  children: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const node = useRef<View>(null);
  const [hovered, setHovered] = useState(false);
  if (!editable) return <View style={styles.value}>{children}</View>;
  return (
    <View ref={node} collapsable={false}>
      <Pressable
        onPress={() => {
          onOpen(null);
          node.current?.measureInWindow?.((x, y, _width, height) => onOpen({ x, y: y + height + 4 }));
        }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="button"
        aria-haspopup="menu"
        accessibilityLabel={label}
        style={[styles.press, hovered && styles.pressHover]}
        testID={testID}
      >
        {children}
      </Pressable>
    </View>
  );
}

function Remove({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} role="button" accessibilityLabel={label} hitSlop={6} testID={testID}>
      <Icon name="close" size={10} color={colors.chromeMuted} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    grid: { gap: space.x1 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: space.x3, minHeight: 32 },
    key: { width: 80, flexShrink: 0, paddingTop: 5, color: colors.chromeMuted },
    cell: { flexGrow: 1, flexShrink: 1, minWidth: 0, justifyContent: "center", minHeight: 30 },
    wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    value: { flexDirection: "row", alignItems: "center", gap: space.x2, color: colors.text },
    muted: { color: colors.chromeMuted },
    press: { flexDirection: "row", alignItems: "center", gap: space.x2, alignSelf: "flex-start", paddingVertical: 4, paddingHorizontal: space.x2, marginLeft: -space.x2, borderRadius: radii.sm },
    pressHover: { backgroundColor: colors.surface3 },
    chip: { flexDirection: "row", alignItems: "center", gap: space.x1 + 2, minWidth: 0 },
    tag: { backgroundColor: colors.chipFill, borderRadius: radii.sm, paddingHorizontal: space.x2, paddingVertical: 2 },
    tagText: { color: colors.muted },
    inline: { paddingLeft: 80 + space.x3, paddingBottom: space.x1 },
  });
