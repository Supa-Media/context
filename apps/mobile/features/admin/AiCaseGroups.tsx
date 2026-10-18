/**
 * The left column of a job's Cases tab (board 19): its case groups, one test
 * list each, with the open group's cases under its name. A group's ⋯ renames
 * it, adds a case, duplicates it or deletes it; deleting asks first, in bold
 * red, and puts the note in the workspace's trash, where it can be restored.
 * The owner, 2026-10-16: "allow me to edit the case group names case items".
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { Menu } from "../design/components/Menu";
import { useFieldFont } from "../design/fieldFont";
import { pointerType } from "../design/tokens";
import type { MenuItem } from "../console/files/menuItem";
import { LinkText, OneWay, Primary, Quiet, Quietly } from "./AiKit";
import type { AiNoteRow } from "./aiCatalog";
import { DRAFTED_KEY } from "./aiModel";
import { groupTitle, type TestList } from "./testList";

type GroupAction = "rename" | "add" | "duplicate" | "delete";

export function AiCaseGroups({ tests, activePath, list, loading, current, busy, onPickGroup, onPickCase, onAddCase, onRename, onDuplicate, onDelete, onNewGroup }: {
  tests: readonly AiNoteRow[];
  activePath: string | null;
  /** The open group's list, as read and edited; null while it is read. */
  list: TestList | null;
  loading: string | null;
  current: number | null;
  busy: boolean;
  onPickGroup: (path: string) => void;
  onPickCase: (number: number) => void;
  onAddCase: () => void;
  onRename: (title: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onNewGroup: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const more = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openMenu = () => {
    more.current?.measureInWindow((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
    setMenu((was) => was ?? { x: 0, y: 0 });
  };
  const activeTitle = list ? (groupTitle(list) ?? tests.find((row) => row.path === activePath)?.title ?? "") : "";
  const count = list?.cases.length ?? 0;
  const items: MenuItem<GroupAction>[] = [
    { id: "rename", label: "Rename group" },
    { id: "add", label: "Add a case" },
    { id: "duplicate", label: "Duplicate group" },
    { id: "delete", label: `Delete group${list ? ` (${count} ${count === 1 ? "case" : "cases"})` : ""}`, danger: true },
  ];
  const run = (id: GroupAction) => {
    setMenu(null);
    if (id === "rename") setRenaming(activeTitle);
    else if (id === "add") onAddCase();
    else if (id === "duplicate") onDuplicate();
    else setDeleting(true);
  };

  return (
    <View style={styles.wrap} testID="admin-ai-cases">
      {tests.map((row) => {
        const open = row.path === activePath;
        return (
          <View key={row.path} style={styles.group} testID={`admin-ai-group-${row.name}`}>
            {open && renaming !== null ? (
              <View style={styles.rename}>
                <TextInput
                  value={renaming}
                  onChangeText={setRenaming}
                  onSubmitEditing={() => {
                    onRename(renaming);
                    setRenaming(null);
                  }}
                  autoFocus
                  style={[styles.input, fieldFont]}
                  accessibilityLabel="Case group name"
                  testID="admin-ai-group-name"
                />
                <Primary label="Rename" disabled={renaming.trim() === ""} onPress={() => { onRename(renaming); setRenaming(null); }} testID="admin-ai-group-rename-save" />
                <Quiet label="Cancel" onPress={() => setRenaming(null)} testID="admin-ai-group-rename-cancel" />
              </View>
            ) : (
              <View style={styles.head}>
                <Pressable role="tab" aria-selected={open} onPress={() => onPickGroup(row.path)} style={styles.headMain} testID={`admin-ai-test-pick-${row.name}`}>
                  <Text variant="rowTitle" numberOfLines={1} style={styles.headTitle}>{open && list ? activeTitle : row.title || row.name}</Text>
                  <Text variant="meta" numberOfLines={1} style={styles.muted}>{open && list ? `· ${count}` : "›"}</Text>
                </Pressable>
                {open ? (
                  <Pressable ref={more} role="button" accessibilityLabel={`More for ${activeTitle}`} onPress={openMenu} hitSlop={8} style={styles.more} testID="admin-ai-group-more">
                    <Text variant="rowTitle" style={styles.muted}>⋯</Text>
                  </Pressable>
                ) : null}
              </View>
            )}
            {open && deleting ? (
              <View style={styles.confirm} testID="admin-ai-group-delete-confirm">
                <OneWay>{`Deletes ${activeTitle} and its ${count} ${count === 1 ? "case" : "cases"}. The note goes to the trash, where it can be restored.`}</OneWay>
                <View style={styles.buttons}>
                  <Quiet label="Delete group" tone="crit" disabled={busy} onPress={() => { setDeleting(false); onDelete(); }} testID="admin-ai-group-delete" />
                  <Quiet label="Cancel" onPress={() => setDeleting(false)} testID="admin-ai-group-delete-cancel" />
                </View>
              </View>
            ) : null}
            {open ? (
              list === null ? (
                <Quietly>{loading ?? "Opening…"}</Quietly>
              ) : (
                <>
                  {list.cases.map((item) => {
                    const selected = item.number === current;
                    const drafted = item.other.some((line) => line.key === DRAFTED_KEY);
                    return (
                      <Pressable key={item.headingIndex} role="tab" aria-selected={selected} onPress={() => onPickCase(item.number)} style={[styles.caseRow, selected && styles.caseOn]} testID={`admin-ai-case-row-${item.number}`}>
                        <Text variant="tree" numberOfLines={1} style={[styles.caseTitle, drafted && styles.muted]}>{`${item.number}. ${item.title}`}</Text>
                        {drafted ? <Pill>drafted</Pill> : null}
                      </Pressable>
                    );
                  })}
                  <LinkText label="+ Add a case" onPress={onAddCase} testID="admin-ai-case-new" />
                </>
              )
            ) : null}
          </View>
        );
      })}
      <View style={styles.newGroup}>
        <LinkText label="+ New case group" onPress={onNewGroup} testID="admin-ai-group-new" />
      </View>
      {menu !== null ? <Menu<GroupAction> items={items} anchor={menu} title={activeTitle} onSelect={run} onDismiss={() => setMenu(null)} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x2, minWidth: 0 },
    group: { gap: 2, minWidth: 0 },
    head: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 6, minWidth: 0 },
    headMain: { flex: 1, flexDirection: "row", alignItems: "baseline", gap: space.x2, minWidth: 0 },
    headTitle: { flexShrink: 1, minWidth: 0 },
    more: { paddingHorizontal: space.x2 },
    rename: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    input: { flex: 1, minWidth: 120, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x2, paddingVertical: 6, color: colors.text },
    caseRow: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 7, paddingLeft: space.x3, paddingRight: space.x2, borderRadius: 8, minWidth: 0 },
    caseOn: { backgroundColor: colors.rowSelected },
    caseTitle: { flex: 1, minWidth: 0, color: colors.text },
    muted: { color: colors.muted },
    confirm: { gap: space.x2, paddingVertical: space.x2 },
    buttons: { flexDirection: "row", gap: space.x2 },
    newGroup: { paddingTop: space.x3, borderTopWidth: 1, borderTopColor: colors.line },
  });
