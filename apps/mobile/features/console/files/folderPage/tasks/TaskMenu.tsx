/**
 * A task row's right-click menu, and the one small step some of its rows
 * lead to: an owner picked, a new tag typed, a day typed. What is offered is
 * `taskMenu.ts`; what each row does is `menuRun.ts`.
 */

import { useState, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Menu } from "../../../../design/components/Menu";
import { place } from "../../../../design/components/popoverPlacement";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors, type Shadows } from "../../../../design/theme";
import type { MenuItem } from "../../menuItem";
import { ownerLabel, type OwnerChoice } from "../items";
import type { FolderItem } from "../model";
import { OwnerPicker } from "../OwnerPicker";
import { PriorityGlyph } from "../Glyphs";
import { dueOf, ownersOf, tagsOf } from "../taskProps";
import type { StatusMenuSection } from "../statuses";
import { DuePanel, TagPanel } from "./QuickAddParts";
import { duePlan, ownersPlan, runMenuAction, tagsPlan, writtenPriority, type MenuAsk } from "./menuRun";
import type { ProjectRef } from "./taskEdits";
import type { TaskHost } from "./taskHost";
import { taskMenuAction, taskMenuItems } from "./taskMenu";
import type { TaskControls } from "./useTaskActions";

export interface TaskMenuProps {
  controls: TaskControls;
  host: TaskHost;
  items: readonly FolderItem[];
  statusSections: readonly StatusMenuSection[];
  projects: readonly ProjectRef[];
  me: string | null;
  owners: OwnerChoice | undefined;
  makeTaskLabel: string;
  onOpen: (item: FolderItem) => void;
  onMakeTask: (item: FolderItem) => void;
}

type Asking = { readonly kind: MenuAsk; readonly path: string; readonly anchor: { x: number; y: number } } | null;

export function TaskMenu(props: TaskMenuProps) {
  const { controls, host, owners } = props;
  const [asking, setAsking] = useState<Asking>(null);
  const open = controls.menu;
  const entry = open === null ? undefined : controls.lookup(open.path);
  const asked = asking === null ? undefined : controls.lookup(asking.path)?.item;
  return (
    <>
      {open !== null && entry !== undefined ? (
        <Menu<string>
          items={menuItems(props, entry.item, entry.parent !== null)}
          anchor={open.anchor}
          title={entry.item.label}
          onDismiss={controls.closeMenu}
          onSelect={(id) => {
            controls.closeMenu();
            const action = taskMenuAction(id);
            if (action === null) return;
            runMenuAction(action, {
              controls,
              entry,
              me: props.me,
              owners,
              projects: props.projects,
              now: new Date(),
              open: props.onOpen,
              makeTask: props.onMakeTask,
              ask: (kind) => setAsking({ kind, path: entry.item.path, anchor: open.anchor }),
              ...(host.copyLink === undefined ? {} : { copyLink: host.copyLink }),
              ...(host.archive === undefined ? {} : { archive: host.archive }),
            });
          }}
        />
      ) : null}
      {asking?.kind === "owner" && asked !== undefined && owners !== undefined ? (
        <OwnerPicker
          current=""
          search={owners.search}
          prefer={owners.prefer}
          anchor={asking.anchor}
          savesTo={null}
          onChoose={(value) => {
            setAsking(null);
            const now = ownersOf(asked.properties);
            const has = now.some((owner) => owner.toLowerCase() === value?.toLowerCase());
            if (value !== null && !has) void controls.perform(ownersPlan(asked, [...now, value], owners));
          }}
          onDismiss={() => setAsking(null)}
          {...(owners.addAgent === undefined ? {} : { onAddAgent: owners.addAgent })}
        />
      ) : null}
      {asking?.kind === "tag" && asked !== undefined ? (
        <FieldPopover anchor={asking.anchor} onDismiss={() => setAsking(null)}>
          <TagPanel
            suggestions={controls.tagSuggestions.filter((tag) => !tagsOf(asked.properties).some((each) => each.toLowerCase() === tag.toLowerCase()))}
            onAdd={(tag) => {
              setAsking(null);
              void controls.perform(tagsPlan(asked, [...tagsOf(asked.properties), tag]));
            }}
            onClose={() => setAsking(null)}
          />
        </FieldPopover>
      ) : null}
      {asking?.kind === "due" && asked !== undefined ? (
        <FieldPopover anchor={asking.anchor} onDismiss={() => setAsking(null)}>
          <DuePanel
            now={new Date()}
            onPick={(day) => {
              setAsking(null);
              void controls.perform(duePlan(asked, day, new Date()));
            }}
            onClose={() => setAsking(null)}
          />
        </FieldPopover>
      ) : null}
    </>
  );
}

function menuItems(props: TaskMenuProps, item: FolderItem, isSubtask: boolean): MenuItem<string>[] {
  const { controls, owners } = props;
  const parent = controls.lookup(item.path)?.parent ?? null;
  const items = taskMenuItems({
    kind: item.status === "" ? "note" : "task",
    status: item.status,
    priority: writtenPriority(item),
    owners: ownersOf(item.properties),
    tags: tagsOf(item.properties),
    hasDue: dueOf(item.properties) !== null,
    isSubtask,
    hasSubtasks: item.progress !== null,
    statusSections: props.statusSections,
    backlog: controls.backlog,
    nestTargets: props.items
      .filter((each) => each.status !== "" && each.path !== item.path && each.path !== parent?.path)
      .map((each) => ({ path: each.path, label: each.label })),
    projects: props.projects,
    tagsInUse: controls.tagSuggestions,
    me: props.me,
    ownerLabel: (value) => ownerLabel(owners, value),
    canCopyLink: props.host.copyLink !== undefined,
    canArchive: props.host.archive !== undefined,
    makeTaskLabel: props.makeTaskLabel,
  });
  // Each priority leads with the glyph its rows are drawn with.
  return items.map((each) =>
    each.id !== "priority" || each.items === undefined
      ? each
      : {
          ...each,
          items: each.items.map((choice) => {
            const scale = choice.id === "priority:none" ? null : (Number(choice.id.slice("priority:p".length)) as 0 | 1 | 2 | 3);
            return { ...choice, leading: <PriorityGlyph priority={scale} /> };
          }),
        },
  );
}

const FIELD_WIDTH = 240;
const FIELD_HEIGHT = 140;

/** A small popover holding one field, where the menu was. */
export function FieldPopover({ anchor, onDismiss, children }: { anchor: { x: number; y: number }; onDismiss: () => void; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const view = useWindowDimensions();
  const box = place(anchor.x, anchor.y, { width: FIELD_WIDTH, height: FIELD_HEIGHT }, view);
  return (
    <Modal transparent visible animationType="none" onRequestClose={onDismiss}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onDismiss}>
        <Pressable onPress={() => {}} style={[styles.popover, { left: box.left, top: box.top, width: box.width }]} testID="task-field-popover">
          <View>{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    scrim: { flex: 1 },
    popover: {
      position: "absolute",
      padding: space.x2,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: shadows.floating,
    } as never,
  });
