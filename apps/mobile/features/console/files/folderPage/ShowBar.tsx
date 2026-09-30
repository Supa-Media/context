/**
 * The List's filter bar (the approved artboard, the owner, 2026-09-29): a
 * search over names, Mine, and a menu for each of Owner, Tag, Priority,
 * Estimate and Due (`FilterMenu.tsx`). A kind with something ticked becomes
 * a chip saying what it keeps ("Tag is context or portal") that reopens its
 * menu, with × to clear it, and Clear clears them all. At the right end of
 * the first line, however far the filters wrap: how many are shown ("3 of
 * 7 · match every filter") and "+ Add task" (`end`) for somebody who may
 * write, at the filters' own size (the owner found it too big, 2026-09-29).
 *
 * A way of looking, per viewer (`showFilter.ts`): nothing here writes to a
 * note, so a member has the same bar as an owner. Mine is the one-press way
 * to tick Owner's Me, and is pressed whenever Me is ticked.
 *
 * On a phone the bar is a search button, "Filter · 2" and Mine, and Filter
 * opens every menu at once as one sheet (`FilterSheet.tsx`): five menus of
 * small buttons are not something a thumb can use in one line.
 */

import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { useFieldFont } from "../../../design/fieldFont";
import { FilterMenu } from "./FilterMenu";
import { FilterSheet } from "./FilterSheet";
import { chipWords, KIND_LABELS, kindOptions, type OptionsContext } from "./filterOptions";
import {
  activeKinds,
  clearKind,
  FILTER_KINDS,
  isFiltered,
  isPicked,
  NO_FILTER,
  OWNER_ME,
  toggle,
  type FilterKind,
  type ShowFilter,
} from "./showFilter";

type Anchor = { x: number; y: number } | null;

export interface Noun {
  readonly one: string;
  readonly many: string;
}

/** "7 projects"; under a filter "3 of 7", and how the chips combine once there are two. */
export function countWords(shown: number, total: number, filter: ShowFilter, noun: Noun): string {
  if (!isFiltered(filter)) return `${total} ${total === 1 ? noun.one : noun.many}`;
  return activeKinds(filter).length > 1 ? `${shown} of ${total} · match every filter` : `${shown} of ${total}`;
}

export function ShowBar({
  filter,
  onChange,
  context,
  shown,
  total,
  noun,
  compact,
  end,
}: {
  filter: ShowFilter;
  onChange: (filter: ShowFilter) => void;
  /** Every task and subtask on the page, and who is who: what the menus offer and count. */
  context: OptionsContext;
  /** Top-level tasks drawn, and in the List at all. */
  shown: number;
  total: number;
  noun: Noun;
  compact: boolean;
  end?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const [menu, setMenu] = useState<{ kind: FilterKind; anchor: Anchor } | null>(null);
  const [sheet, setSheet] = useState(false);
  const [searching, setSearching] = useState(filter.query !== "");
  const options = (kind: FilterKind) => kindOptions(kind, context);
  const active = activeKinds(filter);
  const filtered = isFiltered(filter);
  const clearAll = () => onChange(NO_FILTER);
  const mine =
    context.me === null ? null : (
      <Toggle label="Mine" on={isPicked(filter, "owner", OWNER_ME)} compact={compact} onPress={() => onChange(toggle(filter, "owner", OWNER_ME))} />
    );
  const search = (
    <SearchField
      value={filter.query}
      placeholder={`Search ${noun.many}`}
      compact={compact}
      onChange={(query) => onChange({ ...filter, query })}
    />
  );

  if (compact)
    return (
      <View style={styles.phone}>
        <View style={[styles.bar, styles.barPhone]} role="toolbar" accessibilityLabel="Filter" testID="folder-show-bar">
          <Pressable
            onPress={() => setSearching((open) => !open)}
            role="button"
            aria-expanded={searching}
            accessibilityLabel={`Search ${noun.many}`}
            style={[styles.touch, styles.square, searching && styles.on]}
            testID="folder-filter-search-toggle"
          >
            <Icon name="search" size={16} color={styles.icon.color} />
          </Pressable>
          <Pressable
            onPress={() => setSheet(true)}
            role="button"
            aria-haspopup="dialog"
            accessibilityLabel={active.length === 0 ? "Filter" : `Filter, ${active.length} on`}
            style={[styles.touch, styles.filterButton, active.length > 0 && styles.on]}
            testID="folder-filter-open"
          >
            <Icon name="filter" size={16} color={active.length > 0 ? styles.onText.color : styles.icon.color} />
            <Text variant="body" style={active.length > 0 ? styles.onText : styles.plain}>
              {active.length === 0 ? "Filter" : `Filter · ${active.length}`}
            </Text>
          </Pressable>
          {mine}
          {end === undefined ? null : <View style={styles.end}>{end}</View>}
        </View>
        {searching || filter.query !== "" ? <View style={styles.searchLine}>{search}</View> : null}
        {filtered ? (
          <Text variant="meta" style={styles.count} testID="folder-filter-count">
            {countWords(shown, total, filter, noun)}
          </Text>
        ) : null}
        {sheet ? (
          <FilterSheet
            options={options}
            picked={(kind, value) => isPicked(filter, kind, value)}
            onToggle={(kind, value) => onChange(toggle(filter, kind, value))}
            onClear={active.length === 0 ? null : () => onChange({ ...NO_FILTER, query: filter.query })}
            shown={shown}
            total={total}
            noun={noun.many}
            onClose={() => setSheet(false)}
          />
        ) : null}
      </View>
    );

  return (
    <View style={styles.wide} role="toolbar" accessibilityLabel="Filter" testID="folder-show-bar">
      <View style={styles.bar}>
        {search}
        <View style={styles.divider} />
        {mine}
        {active.map((kind) => (
          <ActiveChip
            key={kind}
            kind={kind}
            words={chipWords(filter, kind, context.who)}
            onOpen={(anchor) => setMenu({ kind, anchor })}
            onClear={() => onChange(clearKind(filter, kind))}
          />
        ))}
        {FILTER_KINDS.filter((kind) => !active.includes(kind) && (kind !== "tag" || options("tag").length > 0)).map((kind) => (
          <MenuButton key={kind} kind={kind} open={menu?.kind === kind} onOpen={(anchor) => setMenu({ kind, anchor })} />
        ))}
        {filtered ? (
          <Pressable onPress={clearAll} role="button" accessibilityLabel="Clear filters" style={styles.clear} testID="folder-filter-clear">
            <Text variant="meta" style={styles.clearText}>
              Clear
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.side}>
        <Text variant="meta" style={styles.count} testID="folder-filter-count">
          {countWords(shown, total, filter, noun)}
        </Text>
        {end === undefined ? null : end}
      </View>
      {menu === null ? null : (
        <FilterMenu
          kind={menu.kind}
          options={options(menu.kind)}
          picked={(value) => isPicked(filter, menu.kind, value)}
          noun={noun.many}
          anchor={menu.anchor}
          onToggle={(value) => onChange(toggle(filter, menu.kind, value))}
          onDismiss={() => setMenu(null)}
        />
      )}
    </View>
  );
}

/** Measures itself and hands where a menu under it should open. */
function useAnchor(): [React.RefObject<View | null>, (open: (anchor: Anchor) => void) => void] {
  const ref = useRef<View>(null);
  return [
    ref,
    (open) => {
      const node = ref.current;
      if (node?.measureInWindow === undefined) open(null);
      else node.measureInWindow((x, y, _width, height) => open({ x, y: y + height + 4 }));
    },
  ];
}

function SearchField({ value, placeholder, compact, onChange }: { value: string; placeholder: string; compact: boolean; onChange: (text: string) => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont();
  return (
    <View style={[styles.search, compact && styles.searchTouch]}>
      <Icon name="search" size={14} color={colors.chromeMuted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.chromeMuted}
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={compact}
        style={[styles.searchInput, fieldFont]}
        testID="folder-filter-search"
        onKeyPress={(event) => {
          if (event.nativeEvent.key === "Escape" && value !== "") onChange("");
        }}
      />
      {value === "" ? null : (
        <Pressable onPress={() => onChange("")} role="button" accessibilityLabel="Clear search" hitSlop={6} testID="folder-filter-search-clear">
          <Icon name="close" size={12} color={colors.chromeMuted} />
        </Pressable>
      )}
    </View>
  );
}

function Toggle({ label, on, compact, onPress }: { label: string; on: boolean; compact: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      aria-pressed={on}
      accessibilityLabel={label}
      style={[styles.button, compact && styles.touch, hovered && styles.hover, on && styles.on]}
      testID="folder-show-mine"
    >
      <Text variant={compact ? "body" : "meta"} style={on ? styles.onText : styles.plain}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A kind with nothing ticked: "+ Tag", dashed, opening its menu. */
function MenuButton({ kind, open, onOpen }: { kind: FilterKind; open: boolean; onOpen: (anchor: Anchor) => void }) {
  const styles = useThemedStyles(makeStyles);
  const [ref, measure] = useAnchor();
  const [hovered, setHovered] = useState(false);
  return (
    <View ref={ref} collapsable={false}>
      <Pressable
        onPress={() => measure(onOpen)}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        role="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        accessibilityLabel={`Filter by ${KIND_LABELS[kind].toLowerCase()}`}
        style={[styles.button, styles.dashed, hovered && styles.hover, open && styles.on]}
        testID={`folder-filter-add-${kind}`}
      >
        <Icon name="plus" size={12} color={styles.icon.color} />
        <Text variant="meta" style={styles.plain}>
          {KIND_LABELS[kind]}
        </Text>
      </Pressable>
    </View>
  );
}

/** A kind that is on: what it keeps, reopening its menu, and × to clear it. */
function ActiveChip({
  kind,
  words,
  onOpen,
  onClear,
}: {
  kind: FilterKind;
  words: { kind: string; value: string };
  onOpen: (anchor: Anchor) => void;
  onClear: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [ref, measure] = useAnchor();
  return (
    <View ref={ref} collapsable={false} style={[styles.button, styles.on, styles.chip]} testID={`folder-filter-chip-${kind}`}>
      <Pressable
        onPress={() => measure(onOpen)}
        role="button"
        aria-haspopup="dialog"
        accessibilityLabel={`${words.kind} ${words.value}, change`}
        style={styles.chipOpen}
        testID="folder-filter-chip-open"
      >
        <Text variant="meta" numberOfLines={1} style={styles.onText}>
          {`${words.kind} `}
          <Text variant="meta" style={[styles.onText, styles.strong]}>
            {kind === "owner" || kind === "tag" ? isolateForDisplay(words.value) : words.value}
          </Text>
        </Text>
      </Pressable>
      <Pressable onPress={onClear} role="button" accessibilityLabel={`Clear ${KIND_LABELS[kind].toLowerCase()}`} hitSlop={4} style={styles.chipClear} testID="folder-filter-chip-clear">
        <Icon name="close" size={11} color={styles.onText.color} />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    phone: { marginBottom: space.x2, gap: space.x2 },
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, flexGrow: 1, flexShrink: 1, minWidth: 0 },
    barPhone: { flexWrap: "nowrap", flexGrow: 0 },
    divider: { width: 1, height: 18, marginHorizontal: 2, backgroundColor: colors.lineStrong },
    // The filters wrap on the left; the count and "+ Add" hold the first line's right end.
    wide: { flexDirection: "row", alignItems: "flex-start", gap: space.x3, marginBottom: space.x2 },
    side: { flexDirection: "row", alignItems: "center", gap: space.x2, height: 28, flexShrink: 0 },
    end: { marginLeft: "auto" },
    icon: { color: colors.text2 },
    plain: { color: colors.text2 },
    onText: { color: colors.accentText },
    strong: { fontWeight: "600" },
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      height: 28,
      paddingHorizontal: 10,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
    },
    dashed: { borderStyle: "dashed" },
    hover: { backgroundColor: colors.surface3 },
    on: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    touch: { height: 44, paddingHorizontal: 14 },
    square: { width: 44, paddingHorizontal: 0, justifyContent: "center", alignItems: "center", borderRadius: radii.md, borderWidth: 1, borderColor: colors.lineStrong },
    filterButton: { flexDirection: "row", alignItems: "center", gap: space.x2, borderRadius: radii.md, borderWidth: 1, borderColor: colors.lineStrong },
    chip: { paddingHorizontal: 0, gap: 0, maxWidth: 320 },
    chipOpen: { height: "100%", justifyContent: "center", paddingLeft: 10, paddingRight: 4, flexShrink: 1, minWidth: 0 },
    chipClear: { height: "100%", width: 24, alignItems: "center", justifyContent: "center" },
    clear: { height: 28, justifyContent: "center", paddingHorizontal: space.x1 },
    clearText: { color: colors.text2, textDecorationLine: "underline" },
    count: { color: colors.chromeMuted, fontVariant: ["tabular-nums"] },
    search: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      width: 200,
      height: 28,
      paddingHorizontal: 8,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
    },
    searchTouch: { width: "100%", height: 44 },
    searchLine: { flexDirection: "row" },
    searchInput: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      paddingVertical: 0,
      backgroundColor: "transparent",
      outlineStyle: "none",
    } as never,
  });
