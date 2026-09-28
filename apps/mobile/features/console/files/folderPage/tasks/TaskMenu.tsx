/**
 * A task row's menu, and the one small step some of its rows lead to: an
 * owner picked, a new tag typed, a day typed. What is offered, and what each
 * row does, is `useTaskMenu` (over `taskMenu.ts` and `menuRun.ts`).
 *
 * One menu, two presentations, chosen by `Menu` itself: a popover at the
 * pointer, and on a phone a sheet from the bottom whose Priority page is a
 * row of chips above the rest, each row showing what it is set to
 * (`phoneSheet.ts`). The ids are the same, so both go through `select`.
 */

import { type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Menu } from "../../../../design/components/Menu";
import { place } from "../../../../design/components/popoverPlacement";
import { radii, space } from "../../../../design/tokens";
import { useThemedStyles, type Colors, type Shadows } from "../../../../design/theme";
import type { OwnerChoice } from "../items";
import { OwnerPicker } from "../OwnerPicker";
import { tagsOf, ownersOf } from "../taskProps";
import { DuePanel, TagPanel } from "./QuickAddParts";
import { duePlan, ownersPlan, tagsPlan } from "./menuRun";
import { phoneSheet } from "./phoneSheet";
import { PriorityChips } from "./PhoneParts";
import type { TaskMenuModel } from "./useTaskMenu";
import type { TaskControls } from "./useTaskActions";

export interface TaskMenuProps {
  controls: TaskControls;
  model: TaskMenuModel;
  owners: OwnerChoice | undefined;
}

export function TaskMenu({ controls, model, owners }: TaskMenuProps) {
  const open = controls.menu;
  const items = open === null ? null : model.itemsFor(open.path);
  const title = open === null ? undefined : controls.lookup(open.path)?.item.label;
  const asking = model.asking;
  const asked = asking === null ? undefined : controls.lookup(asking.path)?.item;
  const sheet = open === null || items === null ? null : phoneSheet(items, model.valuesFor(open.path));
  const select = (id: string) => {
    if (open === null) return;
    controls.closeMenu();
    model.select(open.path, id, open.anchor);
  };
  return (
    <>
      {open !== null && items !== null && sheet !== null ? (
        <Menu<string>
          items={items}
          anchor={open.anchor}
          {...(title === undefined ? {} : { title })}
          sheet={{
            items: sheet.items,
            ...(sheet.chips.length === 0 ? {} : { header: <PriorityChips chips={sheet.chips} onPick={select} /> }),
          }}
          onDismiss={controls.closeMenu}
          onSelect={select}
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
            model.endAsk();
            const now = ownersOf(asked.properties);
            const has = now.some((owner) => owner.toLowerCase() === value?.toLowerCase());
            if (value !== null && !has) void controls.perform(ownersPlan(asked, [...now, value], owners));
          }}
          onDismiss={model.endAsk}
          {...(owners.addAgent === undefined ? {} : { onAddAgent: owners.addAgent })}
        />
      ) : null}
      {asking?.kind === "tag" && asked !== undefined ? (
        <FieldPopover anchor={asking.anchor} onDismiss={model.endAsk}>
          <TagPanel
            suggestions={controls.tagSuggestions.filter((tag) => !tagsOf(asked.properties).some((each) => each.toLowerCase() === tag.toLowerCase()))}
            onAdd={(tag) => {
              model.endAsk();
              void controls.perform(tagsPlan(asked, [...tagsOf(asked.properties), tag]));
            }}
            onClose={model.endAsk}
          />
        </FieldPopover>
      ) : null}
      {asking?.kind === "due" && asked !== undefined ? (
        <FieldPopover anchor={asking.anchor} onDismiss={model.endAsk}>
          <DuePanel
            now={new Date()}
            onPick={(day) => {
              model.endAsk();
              void controls.perform(duePlan(asked, day, new Date()));
            }}
            onClose={model.endAsk}
          />
        </FieldPopover>
      ) : null}
    </>
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
