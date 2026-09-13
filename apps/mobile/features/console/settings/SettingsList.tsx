import { Fragment, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Dot } from "../../design/components/Dot";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useAppearanceChoice, useColors, useThemedStyles, type Colors } from "../../design/theme";
import { atName } from "../format";
import { selectedContext, type ConsoleContext, type ConsoleData } from "../types";
import { settingsPreview } from "./previews";
import {
  matchSettingsSections,
  type SettingsSectionKey,
  type SettingsSectionSpec,
} from "./sections";

/**
 * The settings index: what you can change, and what it is set to now.
 *
 * ## What this replaced, and why
 *
 * Nineteen rows, each holding one word, set in one weight, with no mark, no
 * separator and no value. Nothing told the eye where one group ended and the
 * next began except headings at 10.5pt in `muted` — the least visible type on
 * the screen, carrying the whole of the structure. So the list could not be
 * scanned, only read, and reading it answered nothing: "Storage" did not say
 * R2, "Premium" did not say free, "Email" did not say whether mail was
 * landing. Every question cost a navigation and a trip back.
 *
 * Three changes, and they are the same change three times — put the answer on
 * the row:
 *
 *  - **a mark**, so a row is found by shape rather than by reading;
 *  - **a grouped card with hairlines**, so the structure is drawn rather than
 *    implied by whitespace. The touch target is unchanged;
 *  - **a trailing value**, from `settingsPreview`, which is a claim and
 *    therefore has its own module and its own tests.
 *
 * ## The contexts are a scope bar, not rows
 *
 * They used to be a group at the *foot* of the list, with the open one's
 * sections nested inside its row. Three things were wrong with that. A
 * context is a scope selector, not a setting, so it was filed under the thing
 * it governs. The list's depth changed as you switched, because the nesting
 * moved. And the open context and its open section were two highlight bands
 * stacked directly on top of each other — the old `contextOn`/`rowOn` pair,
 * whose comment worried they "read as one selection spanning both". On a
 * phone they did.
 *
 * Lifted to chips under the search field, all of that goes: every context's
 * health dot is in the first screenful rather than three screens down, the
 * list is flat, and there is exactly one selection left to draw.
 *
 * Chips **wrap** rather than scrolling sideways. A horizontal scroller nested
 * in a vertical one is a gesture fight on both platforms, and the whole point
 * of the row is that a broken workspace is visible without one.
 */
export function SettingsList({
  data,
  active,
  query,
  onQuery,
  onSelect,
  onSwitchContext,
  compact,
  sections,
}: {
  data: ConsoleData;
  /** The section drawn beside this list, which is the one lit in it. */
  active: SettingsSectionKey;
  query: string;
  onQuery: (next: string) => void;
  onSelect: (next: SettingsSectionKey) => void;
  /**
   * Open another context's settings. Absent where there is nowhere to
   * navigate — the landing page's console, and the fixture — in which case
   * the chips still draw, and pressing one does nothing.
   */
  onSwitchContext?: (slug: string) => void;
  compact: boolean;
  sections: readonly SettingsSectionSpec[];
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const current = selectedContext(data);
  /*
    The one preview that is not on `ConsoleData`. It is the person's setting
    rather than the context's, so it is read from the provider here and passed
    down, instead of `settingsPreview` reaching for a hook and stopping being
    a pure function with tests.

    Handed over whole rather than as `choice`, because `choice` is `"system"`
    until the device answers on a native cold start — see `settingsPreview`,
    which takes `ready` with it so that dropping it is a type error rather
    than a thing to remember.
  */
  const appearance = useAppearanceChoice();
  const shown = matchSettingsSections(sections, query);
  const searching = query.trim() !== "";

  const row = (entry: SettingsSectionSpec) => (
    <SettingsRow
      key={entry.key}
      icon={entry.icon}
      label={entry.label}
      value={settingsPreview(entry.key, data, appearance)}
      selected={entry.key === active}
      compact={compact}
      testID={`settings-section-${entry.key}`}
      onPress={() => {
        onSelect(entry.key);
        /*
          The query has done its job the moment somebody picks a row. Left
          standing it kept the list filtered to one or two rows while the
          panel beside it showed a section, which reads as a list that has
          lost most of itself rather than as a search still running.
        */
        onQuery("");
      }}
    />
  );

  /** One group heading and the card of rows under it. */
  const group = (heading: ReactNode, entries: readonly SettingsSectionSpec[], key: string) => {
    if (entries.length === 0) return null;
    return (
      <View key={key} style={styles.group}>
        {heading}
        <View style={[styles.card, compact ? styles.cardCompact : null]}>
          {entries.map((entry, index) => (
            <Fragment key={entry.key}>
              {index === 0 ? null : <View style={styles.divider} />}
              {row(entry)}
            </Fragment>
          ))}
        </View>
      </View>
    );
  };

  const heading = (text: string) => (
    <Text variant="listGroup" style={styles.heading}>
      {text}
    </Text>
  );

  /**
   * The open context's own heading — its name, not a category.
   *
   * "Overview" and "Premium" belong to no group in the catalogue (`group:
   * null`), and under a bare card they read as more account settings. Naming
   * the scope here is what says that everything from this heading down is
   * about @seyi and not about the person.
   */
  const contextHeading = current === null ? null : (
    <View style={styles.contextHeading}>
      <Dot tone={current.status} />
      <Text variant="listGroup" style={styles.headingInline}>
        {`${atName(current.slug)} · ${current.kind === "shared" ? "shared" : "yours"}`}
      </Text>
    </View>
  );

  const contextGroups = () => {
    /*
      No context, no context sections. `contextHeading` already went `null`
      here — a viewer with no workspace, or the moment before the list lands —
      and the rows underneath did not, so thirteen headless rows opened panels
      whose binding would be `undefined` forever. The old nesting made this
      impossible by construction; this is that guarantee written down.
    */
    if (current === null) return null;
    const context = sections.filter((entry) => entry.scope === "context");
    const ungrouped = context.filter((entry) => entry.group === null);
    const named: SettingsSectionSpec["group"][] = [];
    for (const entry of context) {
      if (entry.group !== null && !named.includes(entry.group)) named.push(entry.group);
    }
    return (
      <>
        {group(contextHeading, ungrouped, "context")}
        {named.map((name) =>
          group(
            heading(name as string),
            context.filter((entry) => entry.group === name),
            name as string,
          ),
        )}
      </>
    );
  };

  return (
    <View style={styles.wrap}>
      {/*
        The box is here because a list only works when our name for a thing is
        the reader's. Somebody looking for Gmail does not know it is under
        "Integrations", and somebody who wants to cancel does not think
        "account" — so every section carries the words people actually type,
        and this matches against those as well as the label.
      */}
      <TextInput
        value={query}
        onChangeText={onQuery}
        placeholder="Search settings"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Search settings"
        style={[styles.search, compact ? styles.searchTouch : null]}
        testID="settings-search"
        autoCorrect={false}
        autoCapitalize="none"
      />
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        testID="settings-sections"
      >
        {searching ? (
          /*
            A query flattens the list. The tree below answers "what can I
            change about this context"; a search answers "where is the thing I
            typed", and threading matches back through group headings would
            bury the one row somebody is looking for under scaffolding they
            did not ask for.
          */
          shown.length === 0 ? (
            <Text variant="rowSub" style={styles.empty}>
              {`Nothing matches “${query.trim()}”.`}
            </Text>
          ) : (
            group(null, shown, "results")
          )
        ) : (
          <>
            <ScopeBar
              contexts={data.contexts}
              currentId={current?.id ?? null}
              onSwitchContext={onSwitchContext}
            />
            {group(
              heading("Your account"),
              sections.filter((entry) => entry.scope === "account"),
              "account",
            )}
            {contextGroups()}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Every context this person can reach, with the health of each.
 *
 * The dot is why this is a chip and not a menu button: the list is the only
 * surface that says *which* workspace is broken, and a picker you have to
 * open first sends somebody looking one at a time — the argument the old
 * context rows carried, kept.
 */
function ScopeBar({
  contexts,
  currentId,
  onSwitchContext,
}: {
  contexts: readonly ConsoleContext[];
  currentId: string | null;
  onSwitchContext?: (slug: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  if (contexts.length === 0) return null;
  return (
    <View style={styles.scopeBar}>
      {contexts.map((context) => {
        const open = context.id === currentId;
        return (
          <Pressable
            key={context.id}
            /*
              A `button` with a selected state, not a `tab`: ARIA requires a
              `tab` to be owned by a `tablist`, `aria-selected` is web-only,
              and iOS maps the role to no trait at all — so an orphan tab
              announces its label with no position and no state. What
              `ConsoleRail`'s rows do, for the same reason.
            */
            accessibilityRole="button"
            accessibilityState={{ selected: open }}
            // See `SettingsRow` for why both, and which platform reads which.
            aria-current={open ? "true" : undefined}
            accessibilityLabel={atName(context.slug)}
            testID={`settings-context-${context.slug}`}
            onPress={() => {
              if (!open) onSwitchContext?.(context.slug);
            }}
            style={[styles.chip, open ? styles.chipOn : null]}
          >
            <Dot tone={context.status} />
            <Text variant="wsSwitch" style={open ? styles.chipLabelOn : styles.chipLabel}>
              {atName(context.slug)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * One row: a mark, a label, what it is set to, and — on a phone — a chevron.
 *
 * No chevron under a pointer, and that is a rule rather than a saving. There
 * the list and the panel are on screen together, so a row is a tab and the
 * selection band is what says which one you are on; a chevron would promise a
 * push that never happens. On a phone the row really does push, and the
 * chevron is the only thing that says the list is not the destination.
 */
function SettingsRow({
  icon,
  label,
  value,
  selected,
  compact,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  /** `null` where the row has nothing to add — see `settingsPreview`. */
  value: string | null;
  selected: boolean;
  compact: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      /*
        `aria-current` as well as `accessibilityState`, and both are load-bearing.

        react-native-web drops `selected` for `role="button"` — verified
        against the rendered DOM, where the lit row and its neighbours differ
        by a background-colour class and by nothing else — so on web the one
        row that is *current* was announced exactly like the eighteen that are
        not. `accessibilityState` is what iOS and Android read; `aria-current`
        is what the web needs, it is a global ARIA attribute so it is legal on
        a button, and React Native drops the unknown prop the same way it
        drops the `aria-level` on every heading in this app.
      */
      aria-current={selected ? "true" : undefined}
      /*
        The label alone, not "Storage, R2 · my-bucket". The value is drawn as its
        own text node inside the row, so a screen reader reaches it anyway —
        folding it into the name would say it twice and make every row's
        accessible name change as the data under it did.
      */
      accessibilityLabel={label}
      onPress={onPress}
      testID={testID}
      style={[styles.row, compact ? styles.rowTouch : null, selected ? styles.rowOn : null]}
    >
      <Icon
        name={icon}
        size={compact ? 19 : 17}
        color={selected ? colors.accent : colors.muted}
      />
      <Text
        variant={compact ? "railTouch" : "rail"}
        numberOfLines={1}
        style={[styles.label, selected ? styles.labelOn : null]}
      >
        {label}
      </Text>
      <View style={styles.spacer} />
      {value === null ? null : (
        <Text
          variant={compact ? "rowValueTouch" : "rowSub"}
          numberOfLines={1}
          style={styles.value}
        >
          {value}
        </Text>
      )}
      {compact ? <Icon name="chevronRight" size={13} color={colors.muted} /> : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { flex: 1, minHeight: 0 },
    search: {
      margin: space.x3,
      marginBottom: space.x2,
      minHeight: layout.minTouchTarget,
      paddingHorizontal: space.x3,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.well,
      color: colors.text,
      fontSize: 13,
    },
    // 15 rather than 13, for the reason `railTouch` is 15.5: a field somebody
    // types into on a phone is read at the size the phone is read at.
    searchTouch: { fontSize: 15, backgroundColor: colors.surface2, borderRadius: radii.xl },
    scroll: { paddingBottom: space.x6, paddingHorizontal: space.x3 },
    empty: { paddingHorizontal: space.x2, paddingVertical: space.x3 },
    group: { marginTop: space.x4 },
    heading: { marginBottom: space.x2, paddingHorizontal: space.x2 },
    contextHeading: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      marginBottom: space.x2,
      paddingHorizontal: space.x2,
    },
    headingInline: { flexShrink: 1 },
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      overflow: "hidden",
    },
    cardCompact: { borderRadius: radii.sheet },
    /*
      Inset to where the label starts, not to the card's edge. A full-bleed
      rule cuts the marks off from their rows and turns one grouped card into
      a stack of separate ones, which is the structure the card is there to
      deny.
    */
    divider: { height: 1, backgroundColor: colors.line, marginLeft: 42 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: 8,
      paddingHorizontal: 11,
    },
    /*
      The touch minimum, the arithmetic `ConsoleRail` already wrote down: 8pt
      around a ~21pt line is 37, which is right there and wrong under a thumb.
    */
    rowTouch: { minHeight: layout.minTouchTarget, paddingVertical: space.x3 },
    rowOn: { backgroundColor: colors.accentDim },
    label: { flexShrink: 1 },
    labelOn: { color: colors.accentText },
    /*
      A spacer rather than `marginLeft: "auto"` on the value. An auto margin
      absorbs the free space before anything else sees it, so a row with no
      value would have nothing holding the chevron out at the edge — and a
      chevron that slides left when a preview is absent is a list whose right
      edge moves row to row.
    */
    spacer: { flexGrow: 1, minWidth: space.x2 },
    // Capped, so a long bucket name truncates instead of squeezing the label
    // it is supposed to be answering.
    value: { flexShrink: 1, maxWidth: "48%", textAlign: "right", color: colors.muted },
    scopeBar: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: space.x2,
      marginTop: space.x2,
      paddingHorizontal: space.x1,
    },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 32,
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    chipOn: { backgroundColor: colors.accentDim, borderColor: colors.accent },
    chipLabel: { color: colors.text2 },
    chipLabelOn: { color: colors.accentText, fontWeight: "600" },
  });
