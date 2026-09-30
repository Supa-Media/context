import { Fragment, useCallback, useState, type ReactNode } from "react";
import { useConvex } from "convex/react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { Dot } from "../../design/components/Dot";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { layout, pointerType as t, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { atName } from "../format";
import { selectedContext, type ConsoleContext, type ConsoleData } from "../types";
import { settingsPreview } from "./previews";
import { LiveRowValueSource, type LiveRowValues } from "./liveRowValues";
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
 * ## The workspace is one switcher, not rows
 *
 * Workspaces used to be a group at the foot of the list with the open one's
 * sections nested inside its row, then a bar of chips above both groups. A
 * workspace is a scope, not a setting, so it is neither: it is one box under
 * "This workspace", saying which workspace every row below it is about, and
 * opening to the others with the health dot each one carries.
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
  const shown = matchSettingsSections(sections, query);
  const searching = query.trim() !== "";
  /*
    Plan and Website read subscriptions, so they come from a component mounted
    only where there is a client (see `PremiumPanel` for the same split). The
    demo console has none, and shows the free plan and no website, which is
    what its own panels say.
  */
  const client = useConvex();
  const [live, setLive] = useState<LiveRowValues>({});
  const onValues = useCallback((next: LiveRowValues) => setLive(next), []);
  const subscribing = !data.demo && client !== undefined && current !== null;
  const value = (key: SettingsSectionKey): string | null => {
    if (key === "premium") return data.demo ? "Free" : (live.premium ?? null);
    if (key === "website") return data.demo ? "Off" : (live.website ?? null);
    return settingsPreview(key, data);
  };

  const row = (entry: SettingsSectionSpec) => (
    <SettingsRow
      key={entry.key}
      icon={entry.icon}
      label={entry.label}
      value={value(entry.key)}
      selected={entry.key === active}
      compact={compact}
      testID={`settings-section-${entry.key}`}
      /*
        Its own prefix, not `${testID}-marker`. Every row in this list is
        found by `[data-testid^="settings-section-"]` — `settings.spec.ts`
        sweeps them to measure label alignment — and a child sharing that
        prefix joins the sweep as a row with no label and no box. Found
        exactly that way, by the sweep, the first time this was drawn.
      */
      markerTestID={`settings-marker-${entry.key}`}
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
        {/*
          A plain stack under a pointer, and the grouped card only under a
          thumb. The card was drawn at both, and at a pointer it put a border,
          a fill and five hairlines around a nineteen-row index that is beside
          its own content — six boxes stacked down a 252pt column, each one a
          line the eye has to cross to read the next label. The heading and the
          gap already say where a group starts.

          A phone keeps it, and that is not an inconsistency: there the list is
          the whole screen with nothing beside it, and a grouped card is what
          iOS and Obsidian mobile both use to say a row is pressable.
        */}
        <View
          style={compact ? [styles.card, styles.cardCompact] : null}
          testID={`settings-group-${key}`}
        >
          {entries.map((entry, index) => (
            <Fragment key={entry.key}>
              {index === 0 || !compact ? null : <View style={styles.divider} />}
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
   * "This workspace", and under it the one switcher that picks which.
   *
   * The settings artboard (2026-09-29, approved): the list is two groups, your
   * account and then this workspace, and the workspace is chosen from one box
   * rather than a row of chips above both groups. Chips put three workspaces'
   * names above the person's own settings, and a dot on each; the box says
   * which workspace everything below it is about, in the place it applies.
   */
  const contextHeading = current === null ? null : (
    <View>
      {heading("This workspace")}
      <WorkspaceSwitcher
        contexts={data.contexts}
        current={current}
        onSwitchContext={onSwitchContext}
      />
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
      {subscribing ? (
        <LiveRowValueSource workspaceId={current.id} onValues={onValues} />
      ) : null}
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
 * The workspace this list is about, and a menu of the others.
 *
 * Closed, it is one box: the workspace's letter, its @name and whether it is
 * personal or shared. Open, it lists every workspace this person can reach with
 * the health dot each chip used to carry, so a broken one is still one press
 * away rather than a workspace-by-workspace search.
 */
function WorkspaceSwitcher({
  contexts,
  current,
  onSwitchContext,
}: {
  contexts: readonly ConsoleContext[];
  current: ConsoleContext;
  onSwitchContext?: (slug: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const kind = (context: ConsoleContext) => (context.kind === "shared" ? "Shared" : "Personal");
  return (
    <View style={styles.switcherWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${atName(current.slug)}, ${kind(current)} workspace. Switch workspace`}
        aria-expanded={open}
        onPress={() => setOpen((was) => !was)}
        style={styles.switcher}
        testID="settings-workspace-switcher"
      >
        <View style={styles.tile}>
          <Text variant="rowSub" style={styles.tileLetter}>
            {(current.slug[0] ?? "?").toUpperCase()}
          </Text>
        </View>
        <Text variant="rowTitle" numberOfLines={2} style={styles.switcherName}>
          {atName(current.slug)}
        </Text>
        <Text variant="rowSub" style={styles.switcherKind}>
          {kind(current)}
        </Text>
        <Icon name={open ? "chevronUp" : "chevronDown"} size={13} color={colors.muted} />
      </Pressable>
      {open ? (
        <View style={styles.menu} testID="settings-workspace-menu">
          {contexts.map((context) => {
            const here = context.id === current.id;
            return (
              <Pressable
                key={context.id}
                accessibilityRole="button"
                accessibilityState={{ selected: here }}
                // See `SettingsRow` for why both, and which platform reads which.
                aria-current={here ? "true" : undefined}
                accessibilityLabel={atName(context.slug)}
                testID={`settings-context-${context.slug}`}
                onPress={() => {
                  setOpen(false);
                  if (!here) onSwitchContext?.(context.slug);
                }}
                style={[styles.menuRow, here ? styles.rowOn : null]}
              >
                <Dot tone={context.status} />
                <Text variant="rail" numberOfLines={1} style={styles.label}>
                  {atName(context.slug)}
                </Text>
                <View style={styles.spacer} />
                <Text variant="rowSub" style={styles.value}>
                  {kind(context)}
                </Text>
                {here ? <Icon name="check" size={13} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
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
  markerTestID,
}: {
  icon: IconName;
  label: string;
  /** `null` where the row has nothing to add — see `settingsPreview`. */
  value: string | null;
  selected: boolean;
  compact: boolean;
  onPress: () => void;
  testID: string;
  /** Deliberately not derived from `testID` — see the call site. */
  markerTestID: string;
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
      {/*
        The marker, not only the fill. A selected row that differs by
        background alone is the first thing lost to a contrast problem or a
        dimmed screen, and the tree beside the notes already marks its
        selection this way — so the two selections in this app are drawn the
        same, which is most of what makes them read as one idea.
      */}
      {selected ? <View style={styles.marker} testID={markerTestID} /> : null}
      <Icon
        name={icon}
        size={compact ? 19 : 17}
        color={selected ? colors.accent : colors.muted}
      />
      <Text
        variant={compact ? "railTouch" : "rail"}
        // Two lines rather than an ellipsis: "People & sharing" beside
        // "3 people" is wider than the column, and the artboard wraps it.
        numberOfLines={2}
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
    /*
      A field on the rail rather than a boxed one: `surface` on `ground` is the
      same one-step lift the rest of this column uses, so the border went with
      the cards. The touch minimum stays on a phone (`searchTouch`), where the
      field is a real target rather than a 32pt control under a pointer.
    */
    search: {
      marginHorizontal: space.x3,
      marginTop: space.x3,
      marginBottom: space.x2,
      height: 32,
      paddingHorizontal: space.x3,
      borderRadius: radii.xs,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      color: colors.text,
      fontSize: t.ui,
    },
    // 15 rather than 13, for the reason `railTouch` is 15.5: a field somebody
    // types into on a phone is read at the size the phone is read at.
    searchTouch: {
      minHeight: layout.minTouchTarget,
      height: undefined,
      fontSize: touchType.ui,
      backgroundColor: colors.surface2,
      borderRadius: radii.xl,
      borderWidth: 0,
    },
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
    /*
      28 tall under a pointer — `paddingVertical: 4` around a ~20pt line — and
      on the 4pt ladder rather than the 8/11 it was, which were two of the
      literals the structure sweep exists to remove. A row is `radii.xs` so the
      selection is a band with corners rather than a stripe across a card that
      is no longer there.

      `position: relative` for the marker, which is absolutely placed so it
      cannot push the mark and the label along by its own width.
    */
    row: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: space.x1,
      paddingHorizontal: space.x3,
      borderRadius: radii.xs,
    },
    /*
      The touch minimum, the arithmetic `ConsoleRail` already wrote down: 8pt
      around a ~21pt line is 37, which is right there and wrong under a thumb.
    */
    rowTouch: { minHeight: layout.minTouchTarget, paddingVertical: space.x3 },
    rowOn: { backgroundColor: colors.surface3 },
    /*
      2×14 at the leading edge, the same mark the file tree draws. `surface3`
      above carries "this row" and this carries "this one is the accent's" —
      the fill is the state and the mark is the hue, which is the rule the
      palette states for every other selected thing.
    */
    marker: {
      position: "absolute",
      left: space.x1,
      width: 2,
      height: 14,
      borderRadius: radii.pill,
      backgroundColor: colors.accent,
    },
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
    value: { flexShrink: 0, maxWidth: "48%", textAlign: "right", color: colors.muted },
    switcherWrap: { marginBottom: space.x2 },
    switcher: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      minHeight: 40,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    tile: {
      width: 22,
      height: 22,
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentDim,
    },
    tileLetter: { color: colors.accentText, fontWeight: "700" },
    switcherName: { flexShrink: 1 },
    switcherKind: { marginLeft: "auto", color: colors.muted },
    menu: {
      marginTop: space.x1,
      paddingVertical: space.x1,
      borderRadius: radii.sm,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    menuRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      minHeight: 32,
      paddingHorizontal: space.x3,
      borderRadius: radii.xs,
    },
  });
