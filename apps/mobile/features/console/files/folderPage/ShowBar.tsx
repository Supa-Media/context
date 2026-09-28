/**
 * "Show": whose tasks a project's List draws — Everyone, Mine, No owner,
 * Urgent, or one owner from "Owner ▾", each with how many tasks it would
 * show. A way of looking, per viewer (`showFilter.ts`): nothing here writes
 * to a note, so a member has the same bar as an owner.
 *
 * "Owner ▾" opens a searchable list — No owner, Me, then the people and AI
 * helpers the tasks name, each with a count — as a popover under the button
 * where there is room for one, and a sheet from the bottom on a phone, the
 * rule the owner picker uses.
 *
 * `end` sits at the bar's right: the List's primary "+ Add task", for
 * somebody who may write.
 *
 * On a phone the chips are one line that scrolls sideways (PhoneList
 * artboard) rather than wrapping onto a second and third: the list is what
 * the screen is for, and a chip past the edge is a thumb-flick away.
 */

import { useRef, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Text } from "../../../design/components/Text";
import { place } from "../../../design/components/popoverPlacement";
import { fonts, layout, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import type { Shadows } from "../../../design/tokens/shadows";
import { useFieldFont } from "../../../design/fieldFont";
import { OwnerFace, type Face } from "./Glyphs";
import { ANY_AGENT } from "../owners";
import { ownerOptions, type OwnerWho, type ShowFilter } from "./showFilter";
import type { FolderItem } from "./model";

const WIDTH = 280;
const HEIGHT = 380;

export function ShowBar({
  filter,
  onChange,
  tasks,
  who,
  me,
  counts,
  faceOf,
  compact,
  end,
}: {
  filter: ShowFilter;
  onChange: (filter: ShowFilter) => void;
  /** Every task and subtask on the page: what the owner list counts. */
  tasks: readonly FolderItem[];
  who: OwnerWho;
  /** The viewer's name, for "Me (Seyi)"; null when the page does not know who is looking. */
  me: string | null;
  counts: { readonly noOwner: number; readonly urgent: number; readonly mine: number };
  faceOf: (owner: string) => Face;
  compact: boolean;
  end?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const trigger = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const owner = filter.kind === "owner" ? filter.owner : null;
  const open = () => {
    const measure = trigger.current?.measureInWindow;
    if (measure === undefined) setPicking(true);
    else
      trigger.current?.measureInWindow((x, y, _width, height) => {
        setMenu({ x, y: y + height + 4 });
        setPicking(true);
      });
  };
  return (
    <View style={[styles.bar, compact && styles.barPhone]} role="toolbar" accessibilityLabel="Show" testID="folder-show-bar">
      <Text variant="meta" style={styles.lab}>
        Show
      </Text>
      <Chips compact={compact}>
        <Chip label="Everyone" on={filter.kind === "everyone"} onPress={() => onChange({ kind: "everyone" })} compact={compact} id="everyone" />
        {me === null ? null : <Chip label="Mine" on={filter.kind === "mine"} onPress={() => onChange({ kind: "mine" })} compact={compact} id="mine" />}
        <Chip label={`No owner · ${counts.noOwner}`} on={filter.kind === "no-owner"} onPress={() => onChange({ kind: "no-owner" })} compact={compact} id="no-owner" />
        <Chip label={`Urgent · ${counts.urgent}`} on={filter.kind === "urgent"} onPress={() => onChange({ kind: "urgent" })} compact={compact} id="urgent" />
        <View ref={trigger} collapsable={false}>
          <Chip
            label={owner === null ? "Owner ▾" : `${ownerName(who, owner)} ▾`}
            on={owner !== null}
            onPress={open}
            compact={compact}
            id="owner"
          />
        </View>
      </Chips>
      {picking ? (
        <OwnerFilterMenu
          anchor={menu}
          filter={filter}
          tasks={tasks}
          who={who}
          me={me}
          faceOf={faceOf}
          onChoose={(next) => {
            setPicking(false);
            setMenu(null);
            onChange(next);
          }}
          onDismiss={() => {
            setPicking(false);
            setMenu(null);
          }}
        />
      ) : null}
      {end === undefined ? null : <View style={styles.end}>{end}</View>}
    </View>
  );
}

/** The chips: wrapping where there is room, one sideways-scrolling line on a phone. */
function Chips({ compact, children }: { compact: boolean; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  if (!compact) return <>{children}</>;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.chipScroll}
      contentContainerStyle={styles.chipLine}
      testID="folder-show-chips"
    >
      {children}
    </ScrollView>
  );
}

function ownerName(who: OwnerWho, owner: string): string {
  return owner.trim().toLowerCase() === ANY_AGENT ? "Any AI helper" : isolateForDisplay(who.label(owner));
}

function Chip({ label, on, onPress, compact, id }: { label: string; on: boolean; onPress: () => void; compact: boolean; id: string }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      aria-pressed={on}
      accessibilityLabel={label.replace(" ▾", "")}
      hitSlop={compact ? 6 : 2}
      style={[styles.chip, compact && styles.chipTouch, hovered && styles.chipHover, on && styles.chipOn]}
      testID={`folder-show-${id}`}
    >
      <Text variant="meta" numberOfLines={1} style={[styles.chipText, on && styles.chipTextOn]}>
        {label}
      </Text>
    </Pressable>
  );
}

type Row =
  | { readonly kind: "heading"; readonly label: string }
  | { readonly kind: "choice"; readonly filter: ShowFilter; readonly label: string; readonly count: number; readonly face: Face; readonly on: boolean };

function OwnerFilterMenu({
  anchor,
  filter,
  tasks,
  who,
  me,
  faceOf,
  onChoose,
  onDismiss,
}: {
  anchor: { x: number; y: number } | null;
  filter: ShowFilter;
  tasks: readonly FolderItem[];
  who: OwnerWho;
  me: string | null;
  faceOf: (owner: string) => Face;
  onChoose: (filter: ShowFilter) => void;
  onDismiss: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  const view = useWindowDimensions();
  const [query, setQuery] = useState("");
  const options = ownerOptions(tasks, who, query);
  const q = query.trim().toLowerCase();
  const meLabel = me === null ? null : `Me (${me})`;
  const same = (value: string) => filter.kind === "owner" && who.label(filter.owner).toLowerCase() === who.label(value).toLowerCase();
  const rows: Row[] = [];
  if ("no owner".includes(q)) rows.push({ kind: "choice", filter: { kind: "no-owner" }, label: "No owner", count: options.none, face: { kind: "nobody" }, on: filter.kind === "no-owner" });
  if (meLabel !== null && me !== null && (q === "" || meLabel.toLowerCase().includes(q)))
    rows.push({ kind: "choice", filter: { kind: "mine" }, label: meLabel, count: options.me, face: { kind: "person", name: me }, on: filter.kind === "mine" });
  if (options.people.length > 0) rows.push({ kind: "heading", label: "PEOPLE" });
  for (const person of options.people)
    rows.push({ kind: "choice", filter: { kind: "owner", owner: person.value }, label: person.label, count: person.count, face: faceOf(person.value), on: same(person.value) });
  if (options.agents.length > 0) rows.push({ kind: "heading", label: "AI HELPERS" });
  for (const agent of options.agents)
    rows.push({ kind: "choice", filter: { kind: "owner", owner: agent.value }, label: agent.label, count: agent.count, face: { kind: "agent" }, on: same(agent.value) });
  const choices = rows.filter((row): row is Extract<Row, { kind: "choice" }> => row.kind === "choice");
  const [focus, setFocus] = useState(0);

  const sheet = view.width < layout.narrowBreakpoint || anchor === null;
  const box = sheet ? null : place(anchor.x, anchor.y, { width: WIDTH, height: HEIGHT }, view, { minHeight: 120 });
  return (
    <Modal transparent visible animationType={sheet ? "slide" : "none"} onRequestClose={onDismiss}>
      <Pressable style={[styles.scrim, sheet && styles.scrimSheet]} accessibilityLabel="Close owner list" onPress={onDismiss}>
        <Pressable
          onPress={() => {}}
          style={sheet ? styles.sheet : [styles.popover, box === null ? null : { left: box.left, top: box.top, width: box.width, maxHeight: box.height }]}
          accessibilityLabel="Show tasks owned by"
          testID="folder-owner-filter"
        >
          <TextInput
            autoFocus
            value={query}
            onChangeText={(text) => {
              setQuery(text);
              setFocus(0);
            }}
            placeholder="Search people and AI helpers…"
            placeholderTextColor={colors.chromeMuted}
            accessibilityLabel="Search people and AI helpers"
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.field, fieldFont]}
            testID="folder-owner-filter-field"
            onKeyPress={(event) => {
              const key = event.nativeEvent.key;
              if (key === "Escape") onDismiss();
              else if (key === "ArrowDown" || key === "ArrowUp") {
                (event as unknown as { preventDefault?: () => void }).preventDefault?.();
                if (choices.length > 0) setFocus((at) => (at + (key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length);
              }
            }}
            onSubmitEditing={() => {
              const row = choices[focus];
              if (row !== undefined) onChoose(row.on ? { kind: "everyone" } : row.filter);
            }}
          />
          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {rows.map((row, index) =>
              row.kind === "heading" ? (
                <Text key={`h:${row.label}`} variant="treeMeta" style={styles.heading}>
                  {row.label}
                </Text>
              ) : (
                <Pressable
                  key={`c:${index}`}
                  role="radio"
                  aria-checked={row.on}
                  accessibilityLabel={`${row.label}, ${row.count}`}
                  // Pressing the one already chosen goes back to Everyone.
                  onPress={() => onChoose(row.on ? { kind: "everyone" } : row.filter)}
                  onHoverIn={() => setFocus(choices.indexOf(row))}
                  style={[styles.row, sheet && styles.rowTouch, choices[focus] === row && styles.rowLit]}
                  testID="folder-owner-filter-option"
                >
                  <OwnerFace face={row.face} size={20} />
                  <Text variant="tree" numberOfLines={1} style={styles.label}>
                    {row.kind === "choice" && row.filter.kind === "owner" ? isolateForDisplay(row.label) : row.label}
                  </Text>
                  <Text variant="treeMeta" style={styles.count}>
                    {row.on ? `✓ ${row.count}` : String(row.count)}
                  </Text>
                </Pressable>
              ),
            )}
            {choices.length === 0 ? (
              <Text variant="treeMeta" style={styles.note} role="status">
                Nobody here matches.
              </Text>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: space.x2 },
    barPhone: { flexWrap: "nowrap" },
    lab: { color: colors.chromeMuted, marginRight: 2 },
    chipScroll: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    chipLine: { flexDirection: "row", alignItems: "center", gap: 6 },
    end: { marginLeft: "auto" },
    chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radii.md, backgroundColor: colors.chipFill },
    chipTouch: { paddingVertical: 8 },
    chipHover: { backgroundColor: colors.surface3 },
    chipOn: { backgroundColor: colors.accentDim },
    chipText: { color: colors.text2 },
    chipTextOn: { color: colors.accentText },
    scrim: { flex: 1 },
    scrimSheet: { backgroundColor: colors.scrim, justifyContent: "flex-end" },
    popover: {
      position: "absolute",
      padding: 6,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.surface3,
      boxShadow: shadows.floating,
    },
    sheet: {
      maxHeight: "80%",
      padding: space.x3,
      paddingBottom: space.x6,
      borderTopLeftRadius: radii.floating,
      borderTopRightRadius: radii.floating,
      borderTopWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
    },
    field: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      height: 30,
      paddingHorizontal: 8,
      marginBottom: 4,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
      backgroundColor: "transparent",
    },
    list: { flexGrow: 0 },
    heading: { color: colors.chromeMuted, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 2, letterSpacing: 0.6 },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, height: 32, paddingHorizontal: 8, borderRadius: radii.sm },
    rowTouch: { height: 44 },
    rowLit: { backgroundColor: colors.accentDim },
    label: { flexGrow: 1, flexShrink: 1, color: colors.text },
    count: { color: colors.chromeMuted },
    note: { color: colors.chromeMuted, paddingHorizontal: 10, paddingVertical: 6 },
  });
