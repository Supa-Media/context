/**
 * "Edit statuses…": a folder's status list in its three groups, the way
 * Notion draws a status property's options.
 *
 * - The `+` on a group is the only way to add a status, so a status never
 *   exists without a group.
 * - Each status has a `⋯` menu: rename, move up or down within its group,
 *   move to another group, delete. Moves are keyboard- and thumb-reachable,
 *   which a drag handle alone would not be.
 * - "No status" leads Not started and is not editable: it is the empty value.
 * - In progress and Done always keep one status; the last one offers no
 *   Delete, and the list refuses to save without one anyway.
 * - A rename or a delete that changes notes says how many before it runs
 *   (a delete moves them to the group's next status, or to No status), and
 *   runs only on the second press.
 * - Words the folder's notes use that the list does not hold are listed
 *   last, under "Used here, not in this list": an ordinary word (`active`)
 *   can be added to the list in its group or merged into the group's first
 *   status (which rewrites its notes, so it asks first like a rename), and a
 *   word nobody placed is given a group. This is the only place that tidying
 *   is offered; the page itself only asks, on the word's own heading, which
 *   group an unplaced word is in.
 *
 * Every change is written at once to the front note that holds the list,
 * named at the foot — there is no Save button to forget.
 */

import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Menu } from "../../../design/components/Menu";
import { Text } from "../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { MenuItem } from "../menu";
import { groupLabel } from "../listBlock/words";
import { ChooseGroup } from "./ChooseGroup";
import { GROUPS, GROUP_LABELS, moveStatus, placeStatus, type StatusGroup, type StatusList, type UndeclaredStatus } from "./statuses";
import { StatusPill, toneColor } from "./StatusPill";
import type { StatusEdits, StatusPlan } from "./useStatusEdits";

type Typing = { kind: "add"; group: StatusGroup } | { kind: "rename"; word: string };
type Pending = { verb: "Rename" | "Delete" | "Merge"; word: string; plan: StatusPlan };

export function StatusesDialog({
  list,
  undeclared,
  edits,
  inherited,
  onClose,
}: {
  list: StatusList;
  /** Words in use here that the list does not hold (`undeclaredStatuses`). */
  undeclared: readonly UndeclaredStatus[];
  edits: StatusEdits;
  /** The folder the list is declared in when it is not this one, for the foot. */
  inherited: string | null;
  onClose: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [typing, setTyping] = useState<Typing | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<string | null>) => {
    setBusy(true);
    setProblem(null);
    const answer = await work();
    setBusy(false);
    if (answer !== null) setProblem(answer);
    return answer;
  };

  const startTyping = (next: Typing, initial: string) => {
    setPending(null);
    setProblem(null);
    setDraft(initial);
    setTyping(next);
  };

  const submit = async () => {
    const current = typing;
    const name = draft.trim();
    setTyping(null);
    if (current === null || name === "") return;
    if (current.kind === "add") {
      await run(() => edits.save(placeStatus(list, name, current.group)));
      return;
    }
    if (name === current.word) return;
    setBusy(true);
    const plan = await edits.planRename(current.word, name);
    setBusy(false);
    if (typeof plan === "string") setProblem(plan);
    else if (plan.paths.length === 0) await run(() => edits.apply(plan));
    else setPending({ verb: "Rename", word: current.word, plan });
  };

  const remove = async (word: string) => {
    setBusy(true);
    const plan = await edits.planRemove(word);
    setBusy(false);
    if (typeof plan === "string") setProblem(plan);
    else if (plan.paths.length === 0) await run(() => edits.apply(plan));
    else setPending({ verb: "Delete", word, plan });
  };

  const merge = async (word: string, into: string) => {
    setBusy(true);
    const plan = await edits.planMerge(word, into);
    setBusy(false);
    if (typeof plan === "string") setProblem(plan);
    else if (plan.paths.length === 0) setProblem(`Nothing under this list uses “${word}” any more.`);
    else setPending({ verb: "Merge", word, plan });
  };

  const field = (label: string) => (
    <TextInput
      autoFocus
      value={draft}
      onChangeText={setDraft}
      onSubmitEditing={() => void submit()}
      onBlur={() => void submit()}
      onKeyPress={(event) => {
        if (event.nativeEvent.key === "Escape") setTyping(null);
      }}
      placeholder={label}
      placeholderTextColor={colors.chromeMuted}
      accessibilityLabel={label}
      autoCapitalize="none"
      autoCorrect={false}
      maxLength={40}
      style={styles.field}
      testID="statuses-field"
    />
  );

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel="Statuses" testID="statuses-dialog">
          <View style={styles.titleRow}>
            <Text variant="paneTitle" role="heading" aria-level={2}>
              Statuses
            </Text>
            <Pressable role="button" accessibilityLabel="Done" onPress={onClose} hitSlop={8} testID="statuses-close">
              <Icon name="close" size={14} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll} contentContainerStyle={styles.groups}>
            {GROUPS.map((group) => (
              <View key={group} style={styles.group} testID={`statuses-group-${group}`}>
                <View style={styles.groupHead}>
                  <Text variant="rowTitle" style={{ color: toneColor(colors, group) }}>
                    {GROUP_LABELS[group]}
                  </Text>
                  <Pressable
                    role="button"
                    accessibilityLabel={`Add a status to ${GROUP_LABELS[group]}`}
                    onPress={() => startTyping({ kind: "add", group }, "")}
                    hitSlop={8}
                    disabled={busy}
                    testID={`statuses-add-${group}`}
                  >
                    <Icon name="plus" size={16} color={colors.muted} />
                  </Pressable>
                </View>
                {group === "not-started" ? (
                  <View style={styles.row}>
                    <StatusPill value="" tone="not-started" />
                    <Text variant="badge" style={styles.tag}>
                      DEFAULT
                    </Text>
                  </View>
                ) : null}
                {list[group].map((word, at) =>
                  typing?.kind === "rename" && typing.word === word ? (
                    <View key={word.toLowerCase()} style={styles.row}>
                      {field(`Rename ${word}`)}
                    </View>
                  ) : (
                    <Row
                      key={word.toLowerCase()}
                      word={word}
                      group={group}
                      first={at === 0}
                      last={at === list[group].length - 1}
                      only={group !== "not-started" && list[group].length === 1}
                      disabled={busy}
                      onRename={() => startTyping({ kind: "rename", word }, word)}
                      onMove={(by) => void run(() => edits.save(moveStatus(list, word, by)))}
                      onMoveTo={(to) => void run(() => edits.save(placeStatus(list, word, to)))}
                      onDelete={() => void remove(word)}
                    />
                  ),
                )}
                {typing?.kind === "add" && typing.group === group ? <View style={styles.row}>{field(`New ${GROUP_LABELS[group]} status`)}</View> : null}
              </View>
            ))}
            {undeclared.length === 0 ? null : (
              <View style={[styles.group, styles.inUse]} testID="statuses-in-use">
                <View style={styles.groupHead}>
                  <Text variant="rowTitle" style={styles.inUseHead}>
                    Used here, not in this list
                  </Text>
                </View>
                {undeclared.map((each) => (
                  <InUse
                    key={each.word.toLowerCase()}
                    each={each}
                    disabled={busy}
                    onAdd={(group) => void run(() => edits.save(placeStatus(list, each.word, group)))}
                    onMerge={(into) => void merge(each.word, into)}
                  />
                ))}
              </View>
            )}
          </ScrollView>
          {pending !== null ? (
            <View style={styles.confirm} testID="statuses-confirm">
              <Text variant="tree" style={styles.confirmText}>
                {confirmSentence(pending)}
              </Text>
              <View style={styles.actions}>
                <Button label="Cancel" variant="dialog" onPress={() => setPending(null)} />
                <Button
                  label={`${pending.verb === "Merge" ? "Change" : `${pending.verb} on`} ${pending.plan.paths.length === 1 ? "1 note" : `${pending.plan.paths.length} notes`}`}
                  variant={pending.verb === "Delete" ? "dialogDanger" : "dialogPrimary"}
                  onPress={() => {
                    const plan = pending.plan;
                    setPending(null);
                    void run(() => edits.apply(plan));
                  }}
                  testID="statuses-confirm-go"
                />
              </View>
            </View>
          ) : null}
          {problem !== null ? (
            <Text variant="treeMeta" style={styles.problem} role="alert" testID="statuses-problem">
              {problem}
            </Text>
          ) : busy ? (
            <Text variant="treeMeta" style={styles.foot} role="status">
              Saving…
            </Text>
          ) : null}
          <Text variant="treeMeta" style={styles.foot} testID="statuses-saves-to">
            {inherited === null
              ? `Saves to ${edits.savesTo ?? "this folder"}. Subfolders use this list unless they have their own.`
              : `This list belongs to ${inherited} and saves to ${edits.savesTo ?? "its front note"}, so changes apply there too.`}
          </Text>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function confirmSentence({ verb, word, plan }: Pending): string {
  const count = plan.paths.length === 1 ? "1 note uses" : `${plan.paths.length} notes use`;
  if (verb === "Rename") return `${count} “${word}”. Renaming changes their status to “${plan.to}”.`;
  if (verb === "Merge") return `${count} “${word}”. Merging changes their status to “${plan.to}”.`;
  return plan.to === null
    ? `${count} “${word}”. Deleting it clears their status.`
    : `${count} “${word}”. Deleting it moves them to “${plan.to}”.`;
}

/**
 * One word in use that the list does not hold: its pill, how many notes use
 * it, and what can be done with it.
 */
function InUse({
  each,
  disabled,
  onAdd,
  onMerge,
}: {
  each: UndeclaredStatus;
  disabled: boolean;
  onAdd: (group: StatusGroup) => void;
  onMerge: (into: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const notes = each.count === 1 ? "1 note" : `${each.count} notes`;
  const into = each.mergeInto !== null && each.mergeInto.toLowerCase() !== each.word.toLowerCase() ? each.mergeInto : null;
  return (
    <View style={styles.inUseRow} testID="statuses-in-use-row">
      <View style={styles.inUseWord}>
        <StatusPill value={each.word} tone={each.group ?? "unplaced"} />
        <Text variant="treeMeta" style={styles.foot}>
          {each.group === null ? `${notes} · no group` : `${notes} · reads as ${GROUP_LABELS[each.group]}`}
        </Text>
      </View>
      {each.group === null ? (
        <ChooseGroup word={each.word} onPlace={(_word, group) => onAdd(group)} onEditList={null} />
      ) : (
        <View style={styles.actions}>
          <Button label="Add to list" variant="dialog" disabled={disabled} onPress={() => onAdd(each.group!)} testID="statuses-in-use-add" />
          {into === null ? null : (
            <Button label={`Merge into ${groupLabel("status", into)}`} variant="dialogPrimary" disabled={disabled} onPress={() => onMerge(into)} testID="statuses-in-use-merge" />
          )}
        </View>
      )}
    </View>
  );
}

type RowId = "rename" | "up" | "down" | `to:${StatusGroup}` | "delete";

function Row({
  word,
  group,
  first,
  last,
  only,
  disabled,
  onRename,
  onMove,
  onMoveTo,
  onDelete,
}: {
  word: string;
  group: StatusGroup;
  first: boolean;
  last: boolean;
  /** The group's last status, which a group other than Not started must keep. */
  only: boolean;
  disabled: boolean;
  onRename: () => void;
  onMove: (by: -1 | 1) => void;
  onMoveTo: (group: StatusGroup) => void;
  onDelete: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const trigger = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const items: MenuItem<RowId>[] = [
    { id: "rename", label: "Rename…" },
    ...(first ? [] : [{ id: "up" as const, label: "Move up" }]),
    ...(last ? [] : [{ id: "down" as const, label: "Move down" }]),
    ...(only
      ? []
      : GROUPS.filter((each) => each !== group).map((each, at) => ({
          id: `to:${each}` as const,
          label: `Move to ${GROUP_LABELS[each]}`,
          separatorBefore: at === 0,
        }))),
    ...(only ? [] : [{ id: "delete" as const, label: "Delete", danger: true, separatorBefore: true }]),
  ];
  const open = () => {
    setMenu({ x: 0, y: 0 });
    trigger.current?.measureInWindow?.((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
  };
  return (
    <View style={styles.row} testID="statuses-row">
      <StatusPill value={word} tone={group} />
      <View ref={trigger} collapsable={false} style={styles.more}>
        <Pressable
          role="button"
          aria-haspopup="menu"
          accessibilityLabel={`${word} options`}
          onPress={open}
          disabled={disabled}
          hitSlop={8}
          testID="statuses-row-menu"
        >
          <Icon name="more" size={16} color={colors.muted} />
        </Pressable>
      </View>
      {menu === null ? null : (
        <Menu<RowId>
          items={items}
          {...(menu.x === 0 && menu.y === 0 ? {} : { anchor: menu })}
          title={word}
          onDismiss={() => setMenu(null)}
          onSelect={(id) => {
            setMenu(null);
            if (id === "rename") onRename();
            else if (id === "up") onMove(-1);
            else if (id === "down") onMove(1);
            else if (id === "delete") onDelete();
            else onMoveTo(id.slice("to:".length) as StatusGroup);
          }}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: "rgba(3,3,4,.72)", alignItems: "center", justifyContent: "center", padding: 24 },
    card: {
      width: "100%",
      maxWidth: 400,
      maxHeight: "90%",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 20,
      paddingHorizontal: 20,
      gap: space.x3,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    scroll: { flexGrow: 0 },
    groups: { gap: space.x4 },
    group: { gap: space.x1 },
    groupHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 28 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 32 },
    more: { marginLeft: "auto" },
    tag: { marginLeft: "auto", color: colors.chromeMuted, letterSpacing: 0.6 },
    field: {
      flexGrow: 1,
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      height: 28,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
    inUse: { marginTop: space.x2, paddingTop: space.x4, borderTopWidth: 1, borderTopColor: colors.line },
    inUseHead: { color: colors.muted },
    inUseRow: { gap: space.x2, paddingVertical: space.x2 },
    inUseWord: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    confirm: { gap: space.x2, padding: space.x3, borderRadius: radii.lg, backgroundColor: colors.warnWash, borderWidth: 1, borderColor: colors.warnBorder },
    confirmText: { color: colors.text },
    actions: { flexDirection: "row", gap: 10 },
    problem: { color: colors.critText },
    foot: { color: colors.muted },
  });
