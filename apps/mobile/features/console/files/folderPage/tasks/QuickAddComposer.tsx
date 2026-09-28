/**
 * "+ Add task": the composer a project's List opens inline in a group, and
 * its one-line form under an expanded task for "+ Add subtask".
 *
 * A title field, then the task's few properties as buttons — Priority,
 * Owner, + Tag, Due date — then Cancel and Add task. Enter adds and keeps the
 * composer open, empty, for the next one; Escape closes it. Typing `@Sayo`
 * in the title assigns the task: the word is looked up with the same owner
 * search the picker uses (`resolveMention`), and taken out of the title only
 * when it names exactly one person or agent — otherwise it stays as typed and
 * nobody is assigned.
 *
 * It writes nothing itself. `onAdd` gets the task as words (`QuickAddTask`);
 * the page turns that into a note with `planNewTask` / `planAddSubtask`
 * (`taskWrites.ts`) and resolves to why not, or null. The owner never reads
 * "P0", "frontmatter" or a file name here: a priority is Urgent to Low, a
 * date is Today or "Oct 3".
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Button } from "../../../../design/components/Button";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useFieldFont } from "../../../../design/fieldFont";
import { ownerLabel, type OwnerChoice } from "../items";
import { OwnerPicker } from "../OwnerPicker";
import { ComposerMenu, DuePanel, TagPanel, WordChip, type Anchor } from "./QuickAddParts";
import {
  DUE_PRESET_LABELS,
  PRIORITIES,
  PRIORITY_LABELS,
  dueLabel,
  duePreset,
  parseMention,
  priorityLabel,
  resolveMention,
  toggleWord,
  type DuePreset,
  type Priority,
} from "./taskWords";

/** A task as the composer hands it over: words, not frontmatter. */
export interface QuickAddTask {
  /** Cleaned of a resolved `@name`. */
  readonly title: string;
  readonly priority: Priority | null;
  readonly owners: readonly string[];
  readonly tags: readonly string[];
  /** `YYYY-MM-DD`. */
  readonly due: string | null;
}

export interface QuickAddComposerProps {
  /** Resolves to why the task was not added, or null — then the composer empties for the next. */
  onAdd: (task: QuickAddTask) => Promise<string | null> | string | null;
  onCancel: () => void;
  /** The one-line "Add subtask" form: a title and Add, nothing else. */
  compact?: boolean;
  /** The group the task lands in, for "New task in To do". */
  groupLabel?: string;
  /** Where owners are picked from, and how `@name` is looked up; absent, there is no Owner button. */
  owners?: OwnerChoice;
  /** The tags this project already uses, most used first (`tagsInUse`). */
  tagSuggestions?: readonly string[];
  /** Today, for the due presets; tests pin it. */
  now?: Date;
}

type MenuState = { readonly kind: "priority" | "due" | "owner"; readonly anchor: Anchor } | null;

const EMPTY = { priority: null as Priority | null, owners: [] as string[], tags: [] as string[], due: null as string | null };

export function QuickAddComposer({
  onAdd,
  onCancel,
  compact = false,
  groupLabel,
  owners,
  tagSuggestions = [],
  now,
}: QuickAddComposerProps) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const field = useRef<TextInput>(null);
  const [title, setTitle] = useState("");
  const [props, setProps] = useState(EMPTY);
  const [panel, setPanel] = useState<"tag" | "due" | null>(null);
  const [menu, setMenu] = useState<MenuState>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [mentioned, setMentioned] = useState<{ word: string; value: string | null } | null>(null);
  const today = now ?? new Date();
  const search = owners?.search;
  const prefer = owners?.prefer;
  const mention = parseMention(title).mention;

  // Show who an `@name` will assign while it is typed, a moment after typing pauses.
  useEffect(() => {
    if (mention === null || search === undefined) return;
    let live = true;
    const timer = setTimeout(() => {
      search(mention, prefer ?? [])
        .then((found) => {
          if (live) setMentioned({ word: mention, value: resolveMention(mention, found) });
        })
        .catch(() => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mention, search, prefer]);

  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setProps((current) => ({ ...current, [key]: value }));
  const label = (value: string) => ownerLabel(owners, value);

  // A second Enter while the first is still resolving an owner or saving is the same task twice.
  const inFlight = useRef(false);
  const titleNow = useRef(title);
  titleNow.current = title;

  const submit = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await send();
    } finally {
      inFlight.current = false;
    }
  };

  const send = async () => {
    const typed = title;
    const parsed = parseMention(typed);
    let finalTitle = typed.trim();
    let chosenOwners = props.owners;
    if (parsed.mention !== null && search !== undefined) {
      const value =
        mentioned?.word === parsed.mention
          ? mentioned.value
          : await search(parsed.mention, prefer ?? []).then((found) => resolveMention(parsed.mention!, found)).catch(() => null);
      if (value !== null) {
        finalTitle = parsed.title;
        if (!chosenOwners.some((owner) => owner.toLowerCase() === value.toLowerCase())) chosenOwners = [...chosenOwners, value];
      }
    }
    if (finalTitle.replace(/[\p{Cc}\s]/gu, "") === "") return;
    setAdding(true);
    setProblem(null);
    const answer = await Promise.resolve(onAdd({ title: finalTitle, ...props, owners: chosenOwners })).catch(() => "That task couldn’t be added.");
    setAdding(false);
    if (answer !== null) {
      setProblem(answer);
      return;
    }
    // Whatever was typed while it saved is the next task's start, not something to wipe.
    if (titleNow.current === typed) setTitle("");
    setProps(EMPTY);
    setPanel(null);
    setMentioned(null);
    field.current?.focus();
  };

  const onKey = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (event.nativeEvent.key === "Escape") onCancel();
  };

  const openMenu = (kind: "priority" | "due" | "owner", from: View | null) => {
    setMenu({ kind, anchor: null });
    from?.measureInWindow?.((x, y, _w, height) => setMenu({ kind, anchor: { x, y: y + height + 4 } }));
  };

  const fieldView = (
    <TextInput
      ref={field}
      autoFocus
      value={title}
      onChangeText={(text) => {
        setTitle(text);
        setProblem(null);
      }}
      onKeyPress={onKey}
      onSubmitEditing={() => void submit()}
      blurOnSubmit={false}
      placeholder={compact ? "Add a subtask…" : "Task name"}
      placeholderTextColor={colors.chromeMuted}
      accessibilityLabel={compact ? "New subtask" : "New task"}
      style={[styles.field, compact && styles.fieldCompact, fieldFont]}
      testID="quick-add-title"
    />
  );

  if (compact) {
    return (
      <View style={styles.compact} testID="quick-add-compact">
        {fieldView}
        <Button label="Add" variant="dialogPrimary" onPress={() => void submit()} disabled={adding} testID="quick-add-submit" />
        {problem === null ? null : (
          <Text variant="treeMeta" style={styles.problem} role="alert" testID="quick-add-problem">
            {problem}
          </Text>
        )}
      </View>
    );
  }

  const shownOwner = props.owners[0] ?? (mentioned?.word === mention ? mentioned?.value : null) ?? null;
  const ownerText = shownOwner === null ? "Owner" : `${isolateForDisplay(label(shownOwner))}${props.owners.length > 1 ? ` +${props.owners.length - 1}` : ""}`;

  return (
    <View>
      <View style={styles.card} testID="quick-add">
        {groupLabel === undefined ? null : (
          <Text variant="treeMeta" style={styles.where}>
            {`New task in ${groupLabel}`}
          </Text>
        )}
        {fieldView}
        {props.owners.length > 1 || props.tags.length > 0 ? (
          <View style={styles.row}>
            {props.owners.length > 1
              ? props.owners.map((owner) => (
                  <WordChip key={`o:${owner}`} word={label(owner)} onRemove={() => set("owners", toggleWord(props.owners, owner))} />
                ))
              : null}
            {props.tags.map((tag) => (
              <WordChip key={`t:${tag}`} word={tag} onRemove={() => set("tags", toggleWord(props.tags, tag))} testID="quick-add-tag-chip" />
            ))}
          </View>
        ) : null}
        {panel === "tag" ? (
          <TagPanel
            suggestions={tagSuggestions.filter((tag) => !props.tags.some((chosen) => chosen.toLowerCase() === tag.toLowerCase()))}
            onAdd={(tag) => set("tags", toggleWord(props.tags, tag))}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {panel === "due" ? (
          <DuePanel
            now={today}
            onPick={(day) => {
              set("due", day);
              setPanel(null);
            }}
            onClose={() => setPanel(null)}
          />
        ) : null}
        <View style={styles.row}>
          <Anchored onOpen={(node) => openMenu("priority", node)} label={props.priority === null ? "Priority" : priorityLabel(props.priority)} testID="quick-add-priority" />
          {owners === undefined ? null : <Anchored onOpen={(node) => openMenu("owner", node)} label={ownerText} testID="quick-add-owner" />}
          <Button label="+ Tag" variant="mini" onPress={() => setPanel(panel === "tag" ? null : "tag")} testID="quick-add-tag" />
          <Anchored onOpen={(node) => openMenu("due", node)} label={props.due === null ? "Due date" : dueLabel(props.due, today)} testID="quick-add-due" />
          <View style={styles.push} />
          <Button label="Cancel" variant="dialog" onPress={onCancel} testID="quick-add-cancel" />
          <Button label="Add task" variant="dialogPrimary" onPress={() => void submit()} disabled={adding} testID="quick-add-submit" />
        </View>
        {problem === null ? null : (
          <Text variant="treeMeta" style={styles.problem} role="alert" testID="quick-add-problem">
            {problem}
          </Text>
        )}
      </View>
      <Text variant="treeMeta" style={styles.tip} testID="quick-add-tip">
        Tip: you can also type @Sayo to assign while you write.
      </Text>
      {menu?.kind === "priority" ? (
        <ComposerMenu
          anchor={menu.anchor}
          title="Priority"
          items={[
            ...PRIORITIES.map((priority) => ({ id: priority, label: PRIORITY_LABELS[priority], checked: props.priority === priority })),
            { id: "none", label: priorityLabel(null), checked: props.priority === null },
          ]}
          onSelect={(id) => set("priority", id === "none" ? null : (id as Priority))}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {menu?.kind === "due" ? (
        <ComposerMenu
          anchor={menu.anchor}
          title="Due date"
          items={[
            ...(Object.keys(DUE_PRESET_LABELS) as DuePreset[]).map((preset) => ({ id: preset, label: DUE_PRESET_LABELS[preset] })),
            { id: "pick", label: "Pick a date…" },
            ...(props.due === null ? [] : [{ id: "clear", label: "No due date" }]),
          ]}
          onSelect={(id) => {
            if (id === "pick") setPanel("due");
            else set("due", id === "clear" ? null : duePreset(id as DuePreset, today));
          }}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {menu?.kind === "owner" && owners !== undefined ? (
        <OwnerPicker
          current={props.owners[0] ?? ""}
          search={owners.search}
          prefer={owners.prefer}
          anchor={menu.anchor}
          savesTo={null}
          onChoose={(value) => set("owners", value === null ? [] : toggleWord(props.owners, value))}
          onDismiss={() => setMenu(null)}
          {...(owners.addAgent === undefined ? {} : { onAddAgent: owners.addAgent })}
        />
      ) : null}
    </View>
  );
}

/** A property button that knows where it is, so its menu opens under it. */
function Anchored({ label, onOpen, testID }: { label: string; onOpen: (node: View | null) => void; testID: string }) {
  const node = useRef<View>(null);
  return (
    <View ref={node} collapsable={false}>
      <Button label={label} variant="mini" onPress={() => onOpen(node.current)} testID={testID} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      gap: space.x3,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4 - 2,
      marginTop: space.x1 + 2,
      borderWidth: 1.5,
      borderColor: colors.accent,
      borderRadius: radii.xl + 2,
      backgroundColor: colors.surface,
    },
    compact: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2, paddingVertical: space.x1 },
    where: { color: colors.chromeMuted },
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui + 2,
      color: colors.text,
      padding: 0,
      borderWidth: 0,
      backgroundColor: "transparent",
    },
    fieldCompact: {
      flex: 1,
      minWidth: 160,
      height: 30,
      paddingHorizontal: space.x2,
      fontSize: pointerType.ui,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radii.sm,
    },
    row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x1 + 2 },
    push: { flexGrow: 1 },
    problem: { color: colors.critText },
    tip: { color: colors.chromeMuted, paddingTop: space.x2, paddingHorizontal: space.x1 },
  });
