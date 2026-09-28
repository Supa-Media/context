/**
 * A project's tasks by status, then its notes — the List view of a folder
 * page (`listLayout.ts` decides what is drawn; this draws it).
 *
 * - **Backlog** leads as one folded line ("Backlog 12 · Ideas and later
 *   work, out of the way"), and the Done group ends the tasks the same way;
 *   either opens in place when pressed. Where Backlog is a folder its rows
 *   are what the folder holds, and a drop on the band moves a row into it;
 *   empty, it still says "Backlog 0 · Drop here to park" to a writer.
 * - Every other section is a heading with its count — "1 of 12" under a
 *   filter — and its rows; a section holding several statuses names each
 *   above its own rows. A word nobody placed asks which group it is in on its
 *   own heading, for an owner or editor only, never in a sentence above.
 * - **Notes** close the list: the children with no status, which are not
 *   tasks, each with "Make it a task" for somebody who may write.
 *
 * A row opens its note or folder; a task's chevron opens its subtasks in
 * place (`TaskRow.tsx`). On a phone the columns move under the name, and
 * each column is one card like the Notes view's.
 *
 * For somebody who may write (`actions.tasks`), each open group ends with
 * "+ Add task" (a task in that group's first status), the primary "+ Add
 * task" opens the composer at the top of the first To do group, and every
 * group and folded band takes a dragged task: its status, or Backlog.
 */

import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { ChooseGroup } from "./ChooseGroup";
import { groupLabel } from "../listBlock/words";
import { AddLine, DropArea, TaskComposer } from "./tasks/RowParts";
import type { TaskControls } from "./tasks/useTaskActions";
import type { ItemActions } from "./items";
import { BACKLOG_EMPTY_HINT, BACKLOG_HINT, type LayoutColumn, type LayoutSection, type ListLayout } from "./listLayout";
import { StatusPill, toneColor } from "./StatusPill";
import { NoteRow, RowList, TaskRow } from "./TaskRow";

export function FolderGroups({
  layout,
  compact,
  now,
  actions,
}: {
  layout: ListLayout;
  compact: boolean;
  now: number;
  actions: ItemActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (set: (next: (current: ReadonlySet<string>) => ReadonlySet<string>) => void, key: string) =>
    set((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const count = (section: { shown: number; total: number }) =>
    layout.filtered ? `${section.shown} of ${section.total}` : String(section.total);
  const tasks = actions.tasks ?? null;
  const composer = tasks?.composer ?? null;
  const writing = composer?.kind === "task" ? composer : null;
  // The primary button's composer, when the group it belongs at the top of is not drawn (no To do yet, or filtered away).
  const loose = writing !== null && writing.at === "top" && !layout.sections.some((section) => section.key === writing.section && !section.folded);
  const openOn = composer?.kind === "subtask" ? composer.parent : null;
  const onToggle = (path: string) => toggle(setOpened, path);
  const composerAt = (section: LayoutSection, at: "top" | "end") =>
    tasks !== null && writing !== null && writing.section === section.key && writing.at === at ? (
      <TaskComposer controls={tasks} status={writing.status} groupLabel={groupLabel("status", writing.status)} />
    ) : null;
  const addLine = (section: LayoutSection) =>
    // A Backlog folder is dropped into rather than written in: its rows are added where they are made.
    tasks === null || section.folder != null || (writing !== null && writing.section === section.key) ? null : (
      <AddLine
        label={tasks.addLabel}
        onPress={() => tasks.openComposer({ kind: "task", section: section.key, status: sectionStatus(section, tasks), at: "end" })}
        testID="folder-add-task"
      />
    );
  return (
    <View testID="folder-groups" style={styles.stack}>
      {loose && tasks !== null ? (
        <TaskComposer controls={tasks} status={writing.status} groupLabel={groupLabel("status", writing.status)} />
      ) : null}
      {layout.sections.map((section) =>
        section.folded ? (
          <View key={section.key} testID="folder-group">
            <DropArea controls={tasks} status={tasks === null ? "" : sectionStatus(section, tasks)} park={section.key === "backlog"}>
              {(hint) => (
                <FoldedBand
                  section={section}
                  count={count(section)}
                  open={unfolded.has(section.key)}
                  onToggle={() => toggle(setUnfolded, section.key)}
                  hint={hint}
                  writer={tasks !== null}
                />
              )}
            </DropArea>
            {unfolded.has(section.key) ? (
              <>
                {composerAt(section, "top")}
                <Columns section={section} compact={compact} now={now} actions={actions} opened={opened} openOn={openOn} onToggle={onToggle} />
                {composerAt(section, "end")}
                {addLine(section)}
              </>
            ) : null}
          </View>
        ) : (
          <DropArea key={section.key} controls={tasks} status={tasks === null ? "" : sectionStatus(section, tasks)} testID="folder-group">
            {(hint) => (
              <>
                <SectionHead section={section} count={count(section)} actions={actions} hint={hint} />
                {composerAt(section, "top")}
                <Columns section={section} compact={compact} now={now} actions={actions} opened={opened} openOn={openOn} onToggle={onToggle} />
                {composerAt(section, "end")}
                {addLine(section)}
              </>
            )}
          </DropArea>
        ),
      )}
      {layout.notes.length === 0 ? null : (
        <View testID="folder-notes">
          <View style={styles.head}>
            <Text variant="rowTitle" style={styles.notesTitle}>
              Notes
            </Text>
            <Text variant="tree" style={styles.count}>
              {String(layout.notes.length)}
            </Text>
            <Text variant="meta" style={styles.count}>
              · no status, so not tasks
            </Text>
          </View>
          <RowList compact={compact}>
            {layout.notes.map((item) => (
              <NoteRow key={item.path} item={item} compact={compact} now={now} actions={actions} />
            ))}
          </RowList>
        </View>
      )}
    </View>
  );
}

/** The status a group's "+ Add task" writes and a drop on it sets: its first, and for To do the first that is not Backlog. */
export function sectionStatus(section: LayoutSection, tasks: Pick<TaskControls, "list" | "firstToDo" | "backlog">): string {
  if (section.key === "not-started") return tasks.firstToDo;
  if (section.key === "backlog") return tasks.backlog ?? section.columns[0]?.value ?? "";
  if (section.group !== null) return tasks.list[section.group][0] ?? section.columns[0]?.value ?? "";
  return section.columns[0]?.value ?? "";
}

function DropHint({ hint }: { hint: string | null }): ReactNode {
  const styles = useThemedStyles(makeStyles);
  return hint === null ? null : (
    <Text variant="meta" numberOfLines={1} style={[styles.hint, styles.headEnd]} role="status" testID="folder-drop-hint">
      {hint}
    </Text>
  );
}

function SectionHead({ section, count, actions, hint }: { section: LayoutSection; count: string; actions: ItemActions; hint: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const place = section.group === null ? actions.onPlaceStatus : null;
  return (
    <View style={styles.head}>
      <Text variant="rowTitle" style={{ color: toneColor(colors, section.group ?? "unplaced") }}>
        {section.label}
      </Text>
      <Text variant="tree" style={styles.count}>
        {count}
      </Text>
      {place !== null && section.columns.length === 1 ? (
        <View style={styles.headEnd}>
          <ChooseGroup word={section.columns[0].value} onPlace={place} onEditList={actions.onEditStatuses} />
        </View>
      ) : null}
      <DropHint hint={hint} />
    </View>
  );
}

function FoldedBand({
  section,
  count,
  open,
  onToggle,
  hint,
  writer,
}: {
  section: LayoutSection;
  count: string;
  open: boolean;
  onToggle: () => void;
  hint: string | null;
  /** Somebody who may drop here: an empty Backlog says so. */
  writer: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      onPress={onToggle}
      role="button"
      aria-expanded={open}
      accessibilityLabel={`${section.label}, ${count}`}
      style={styles.band}
      testID="folder-band"
    >
      <Icon name={open ? "chevronDown" : "chevronRight"} size={13} color={colors.chromeMuted} />
      <Text variant="rowTitle" style={styles.bandTitle}>
        {section.label}
      </Text>
      <Text variant="tree" style={styles.count}>
        {count}
      </Text>
      {hint !== null ? (
        <DropHint hint={hint} />
      ) : section.key === "backlog" ? (
        <Text variant="meta" numberOfLines={1} style={[styles.count, styles.headEnd]} testID="folder-band-hint">
          {section.total === 0 && writer ? BACKLOG_EMPTY_HINT : BACKLOG_HINT}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Columns({
  section,
  compact,
  now,
  actions,
  opened,
  openOn,
  onToggle,
}: {
  section: LayoutSection;
  compact: boolean;
  now: number;
  actions: ItemActions;
  opened: ReadonlySet<string>;
  /** The task a subtask is being added to: open, so the composer is under it. */
  openOn: string | null;
  onToggle: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const several = section.columns.length > 1;
  const place = section.group === null ? actions.onPlaceStatus : null;
  return (
    <>
      {section.columns.map((column: LayoutColumn) => (
        <View key={column.value.toLowerCase()} style={several && styles.status} testID="folder-status">
          {several ? (
            <View style={styles.statusHead}>
              <StatusPill value={column.value} tone={section.group ?? "unplaced"} />
              <Text variant="meta" style={styles.count}>
                {String(column.rows.length)}
              </Text>
              {place === null ? null : (
                <View style={styles.headEnd}>
                  <ChooseGroup word={column.value} onPlace={place} onEditList={actions.onEditStatuses} />
                </View>
              )}
            </View>
          ) : null}
          <RowList compact={compact}>
            {column.rows.map((entry) => (
              <TaskRow
                key={entry.item.path}
                entry={entry}
                // Kept only for a subtask that matches: shown open, so the reason it is here is in sight.
                open={opened.has(entry.item.path) || entry.dim || openOn === entry.item.path}
                onToggle={() => onToggle(entry.item.path)}
                compact={compact}
                now={now}
                actions={actions}
              />
            ))}
          </RowList>
        </View>
      ))}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: space.x5 },
    head: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: space.x2,
      minHeight: 32,
      paddingTop: space.x2,
    },
    count: { color: colors.chromeMuted },
    headEnd: { marginLeft: "auto", alignSelf: "center", flexShrink: 1 },
    notesTitle: { color: colors.muted },
    band: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderRadius: radii.md,
      backgroundColor: colors.chipFill,
    },
    bandTitle: { color: colors.muted },
    status: { marginTop: space.x3 },
    statusHead: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingBottom: space.x2 },
    hint: { color: colors.accentText },
  });
