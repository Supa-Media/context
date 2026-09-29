/**
 * "2 selected · Status · Priority · Owner · Move to Backlog · Archive · ✕":
 * what a selection of tasks can be given at once. Each is one change over
 * all of them, sent together (`runManyPlanned`), said once and taken back by one Undo
 * (`TaskControls.performMany`). Archive is the console's own archive dialog,
 * with its own Undo.
 */

import { useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Button } from "../../../../design/components/Button";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../../../../design/theme";
import { groupLabel } from "../../listBlock/words";
import { ownerLabel, type OwnerChoice } from "../items";
import type { FolderItem } from "../model";
import { OwnerPicker } from "../OwnerPicker";
import type { StatusMenuSection } from "../statuses";
import { ComposerMenu, type Anchor } from "./QuickAddParts";
import { ownersPlan, priorityPlan } from "./menuRun";
import { countTasks, statusPlan } from "./taskEdits";
import type { TaskHost } from "./taskHost";
import { PRIORITIES, PRIORITY_LABELS, priorityLabel, type Priority } from "./taskWords";
import type { TaskControls } from "./useTaskActions";

type Open = { readonly kind: "status" | "priority" | "owner"; readonly anchor: Anchor } | null;

/** The picked rows, without any whose task is picked too — archiving a task takes its subtasks with it. */
export function topmost(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)));
}

export function SelectionBar({
  controls,
  host,
  statusSections,
  owners,
}: {
  controls: TaskControls;
  host: TaskHost;
  statusSections: readonly StatusMenuSection[];
  owners: OwnerChoice | undefined;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<Open>(null);
  const picked = [...controls.selected]
    .map((path) => controls.lookup(path)?.item)
    .filter((item): item is FolderItem => item !== undefined && item.status !== "");
  if (picked.length === 0) return null;
  const count = picked.length;

  const setStatus = (status: string) =>
    void controls.performMany(
      picked.map((item) => statusPlan(item, status)),
      (done) => `Moved ${countTasks(done)} to ${groupLabel("status", status)}.`,
    );
  const setPriority = (priority: Priority | null) =>
    void controls.performMany(
      picked.map((item) => priorityPlan(item, priority)),
      (done) => (priority === null ? `Took the priority off ${countTasks(done)}.` : `${countTasks(done)} ${done === 1 ? "is" : "are"} ${priorityLabel(priority)} now.`),
    );
  const setOwner = (owner: string | null) =>
    void controls.performMany(
      picked.map((item) => ownersPlan(item, owner === null ? [] : [owner], owners)),
      (done) => (owner === null ? `${countTasks(done)} ${done === 1 ? "has" : "have"} no owner now.` : `Gave ${countTasks(done)} to ${ownerLabel(owners, owner)}.`),
    );
  const park = () =>
    void controls.performMany(
      picked.map((item) => controls.parkPlan(item)),
      (done) => `Moved ${countTasks(done)} to Backlog.`,
    );

  return (
    <View style={[styles.bar, Platform.OS === "web" && styles.sticky]} role="toolbar" accessibilityLabel={`${count} selected`} testID="task-selection-bar">
      <Text variant="tree" style={styles.count} testID="task-selection-count">
        {`${count} selected`}
      </Text>
      <Opener label="Status" onOpen={(anchor) => setOpen({ kind: "status", anchor })} testID="task-selection-status" />
      <Opener label="Priority" onOpen={(anchor) => setOpen({ kind: "priority", anchor })} testID="task-selection-priority" />
      {owners === undefined ? null : <Opener label="Owner" onOpen={(anchor) => setOpen({ kind: "owner", anchor })} testID="task-selection-owner" />}
      {controls.backlog === null && controls.backlogFolder === null ? null : <Button label="Move to Backlog" variant="mini" onPress={park} testID="task-selection-park" />}
      {host.archive === undefined ? null : (
        <Button
          label="Archive"
          variant="mini"
          onPress={() => {
            host.archive!(topmost(picked.map((item) => item.path)));
            controls.clearPicks();
          }}
          testID="task-selection-archive"
        />
      )}
      <Pressable onPress={controls.clearPicks} role="button" accessibilityLabel="Clear selection" hitSlop={8} style={styles.clear} testID="task-selection-clear">
        <Icon name="close" size={12} color={colors.chromeMuted} />
      </Pressable>
      {open?.kind === "status" ? (
        <ComposerMenu
          anchor={open.anchor}
          title="Status"
          items={statusSections.flatMap((section) => section.words.filter((word) => word !== "").map((word) => ({ id: word, label: groupLabel("status", word) })))}
          onSelect={setStatus}
          onDismiss={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "priority" ? (
        <ComposerMenu
          anchor={open.anchor}
          title="Priority"
          items={[...PRIORITIES.map((priority) => ({ id: priority, label: PRIORITY_LABELS[priority] })), { id: "none", label: priorityLabel(null) }]}
          onSelect={(id) => setPriority(id === "none" ? null : (id as Priority))}
          onDismiss={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === "owner" && owners !== undefined ? (
        <OwnerPicker
          current=""
          search={owners.search}
          prefer={owners.prefer}
          anchor={open.anchor}
          savesTo={null}
          onChoose={(value) => {
            setOpen(null);
            setOwner(value);
          }}
          onDismiss={() => setOpen(null)}
        />
      ) : null}
    </View>
  );
}

/** A bar button whose menu opens above it. */
function Opener({ label, onOpen, testID }: { label: string; onOpen: (anchor: Anchor) => void; testID: string }) {
  const node = useRef<View>(null);
  return (
    <View ref={node} collapsable={false}>
      <Button
        label={label}
        variant="mini"
        onPress={() => {
          onOpen(null);
          node.current?.measureInWindow?.((x, y) => onOpen({ x, y: Math.max(0, y - 8) }));
        }}
        testID={testID}
      />
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: space.x2,
      marginTop: space.x4,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: shadows.floating,
    } as never,
    // Stays in reach at the foot of the window while the list scrolls under it.
    sticky: { position: "sticky", bottom: space.x4, zIndex: 3 } as never,
    count: { color: colors.text, marginRight: space.x2 },
    clear: { marginLeft: "auto", padding: space.x1 },
  });
