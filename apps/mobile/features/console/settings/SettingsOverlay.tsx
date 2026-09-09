import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useState } from "react";
import { Overlay } from "../../design/components/Overlay";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";

import { layout, radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { SettingsPane, StatusPill } from "../panes/SettingsPane";
import { AccountSection } from "./AccountSections";
import { atName } from "../format";
import { appSectionsFor, type AppSectionKey } from "../nav";
import { selectedContext, type ConsoleData, type StatusTone } from "../types";
import {
  DEFAULT_SETTINGS_SECTION,
  isAccountSection,
  matchSettingsSections,
  settingsSectionsFor,
  type SettingsSectionKey,
  type SettingsSectionSpec,
} from "./sections";

/**
 * Settings, drawn over the context somebody is already looking at.
 *
 * The pane's content is unchanged — the same binding card, the same connect
 * form, the same ingestion and search cards. What changed is that it is no
 * longer one scroll opening on an access key: the sections are addressable,
 * the list is the index, and the note behind the scrim keeps its place in the
 * URL. `SettingsPane` renders one block at a time when given a `section`; this
 * component owns the chrome around it.
 *
 * The group headings are the point of the ordering. "What comes in" and "Your
 * notes" are questions a person can answer without knowing what a bucket is,
 * which the previous headings — Storage, Integrations, Email ingestion — were
 * not. A section absent from `settingsSectionsFor` is absent from the list
 * rather than disabled: a shared workspace has no capture address, and a
 * greyed row inviting somebody to press it is a worse answer than no row.
 */
export function SettingsOverlay({
  data,
  section,
  onSelect,
  onOpenSection,
  onSwitchContext,
  onSignOut,
  onOpenInvitation,
  onDismiss,
}: {
  data: ConsoleData;
  section: SettingsSectionKey;
  onSelect: (next: SettingsSectionKey) => void;
  /**
   * Map and Connections, which are console destinations rather than settings.
   * They are rendered at the foot of whichever section is open because this
   * list is the only surface `features/app/reachability.ts` claims those two
   * routes are reachable from — dropping it here would make them unreachable
   * rather than merely tidier.
   */
  onOpenSection?: (key: AppSectionKey) => void;
  /**
   * Open another context's settings. Absent where there is nowhere to
   * navigate — the landing page's console, and the fixture — in which case
   * the other contexts are still listed but pressing one does nothing.
   */
  onSwitchContext?: (slug: string) => void;
  /** Ends the session. Absent where there is none. */
  onSignOut?: () => void;
  /** Answering an invitation is a navigation to `inviteHref(token)`. */
  onOpenInvitation?: (token: string) => void;
  onDismiss: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const current = selectedContext(data);
  /*
    A phone shows the list, then the section, rather than both at once. It
    starts on the section because opening settings from the gear or the
    storage chip is somebody asking for a *thing*, not for a menu — the list
    is one press back from there.
  */
  const compact = useWindowDimensions().width < layout.narrowBreakpoint;
  const [listing, setListing] = useState(false);
  const [query, setQuery] = useState("");
  const sections = settingsSectionsFor(
    current?.kind === "personal" || current?.kind === "shared" ? current.kind : null,
  );

  /*
    A URL naming a section this context does not have — `?settings=sources` on
    a shared workspace — lands on the default rather than on nothing.

    The default by name, not `sections[0]`: the first row became an account
    section the moment one was prepended, so a positional fallback silently
    started answering "the section you asked for is gone" with AI apps.
  */
  const active = sections.some((entry) => entry.key === section)
    ? section
    : DEFAULT_SETTINGS_SECTION;

  /* Declared above the list: the context rows read it to decide what is lit. */
  const account = isAccountSection(active);
  const shown = matchSettingsSections(sections, query);
  const searching = query.trim() !== "";

  /**
   * One row in the list — a section, or a context you are not in.
   *
   * `onPress` rather than a key, because the two do different things: a
   * section changes which panel is drawn, a context changes which context the
   * whole overlay is about.
   */
  const rowFor = (
    key: string,
    label: string,
    on: boolean,
    onPress: () => void,
    options: { trailing?: string; indented?: boolean; tone?: StatusTone } = {},
  ) => (
    <Pressable
      key={key}
      /*
        A `button` with a selected state, not a `tab`: ARIA requires a `tab` to
        be owned by a `tablist`, `aria-selected` is web-only, and iOS maps the
        role to no trait at all — so an orphan tab announces its label with no
        position and no state. This is what `ConsoleRail`'s rows do, for the
        same reason.
      */
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={[
        styles.row,
        options.indented ? styles.rowIndent : null,
        compact ? styles.rowTouch : null,
        on ? (options.tone === undefined ? styles.rowOn : styles.contextOn) : null,
      ]}
      testID={key}
    >
      {/*
        A context row carries the health of its bucket, the same dot the rail
        draws. This list is now the only place a broken workspace can be
        reached from without leaving settings first, so a row that does not say
        which one is broken sends people looking one at a time.
      */}
      {options.tone === undefined ? null : <Dot tone={options.tone} />}
      <Text
        variant={compact ? "railTouch" : "rail"}
        style={on ? styles.labelOn : undefined}
      >
        {label}
      </Text>
      {options.trailing === undefined ? null : (
        <Text variant="rowSub" style={styles.rowTrailing}>
          {options.trailing}
        </Text>
      )}
    </Pressable>
  );

  const sectionRow = (entry: SettingsSectionSpec, indented: boolean) =>
    rowFor(
      `settings-section-${entry.key}`,
      entry.label,
      entry.key === active,
      () => {
        onSelect(entry.key);
        /*
          The query has done its job the moment somebody picks a row. Left
          standing it kept the list filtered to one or two rows while the panel
          beside it showed a section, which reads as a list that has lost most
          of itself rather than as a search still running.
        */
        setQuery("");
        setListing(false);
      },
      { indented },
    );

  /** The section rows of one context, under their group headings. */
  const contextSections = () => {
    let group: SettingsSectionSpec["group"] | undefined = undefined;
    return sections
      .filter((entry) => entry.scope === "context")
      .map((entry) => {
        const heading = entry.group !== group ? entry.group : null;
        group = entry.group;
        return (
          <View key={entry.key}>
            {heading === null ? null : (
              <Text variant="railHead" style={[styles.group, styles.groupIndent]}>
                {heading}
              </Text>
            )}
            {sectionRow(entry, true)}
          </View>
        );
      });
  };

  /*
    The contexts, by kind, with the open one carrying its own settings beneath
    it. This is what makes the overlay answer the question it is named for: the
    old list was the *selected* context's sections and nothing else, so
    changing a workspace's storage meant leaving settings, switching contexts
    in the rail, and opening settings again.

    A context you are not in is one press, not a disclosure triangle: settings
    for two contexts open at once is two answers to "what is my bucket".
  */
  const contextGroup = (heading: string, kind: "personal" | "shared") => {
    const rows = data.contexts.filter((context) => context.kind === kind);
    if (rows.length === 0) return null;
    return (
      <View key={heading}>
        <Text variant="railHead" style={styles.group}>
          {heading}
        </Text>
        {rows.map((context) => {
          const open = context.id === current?.id;
          return (
            <View key={context.id}>
              {rowFor(
                `settings-context-${context.slug}`,
                atName(context.slug),
                open && !account,
                () => {
                  if (!open) onSwitchContext?.(context.slug);
                  setListing(false);
                },
                {
                  trailing: context.role === "owner" ? "yours" : undefined,
                  tone: context.status,
                },
              )}
              {open ? contextSections() : null}
            </View>
          );
        })}
      </View>
    );
  };

  const list = (
    <View style={styles.sideWrap}>
      {/*
        The box is here because a list only works when our name for a thing is
        the reader's. Somebody looking for Gmail does not know it is under
        "Mail, calendar & chats", and somebody who wants to cancel does not
        think "account" — so every section carries the words people actually
        type, and this matches against those as well as the label.
      */}
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Search settings"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Search settings"
        style={styles.search}
        testID="settings-search"
        autoCorrect={false}
        autoCapitalize="none"
      />
      <ScrollView
        contentContainerStyle={styles.side}
        keyboardShouldPersistTaps="handled"
        testID="settings-sections"
      >
        {/*
          A query flattens the list. The tree below answers "what can I change
          about this context"; a search answers "where is the thing I typed",
          and threading matches back through context headings would bury the
          one row somebody is looking for under scaffolding they did not ask
          for.
        */}
        {searching ? (
          <>
            {shown.length === 0 ? (
              <Text variant="rowSub" style={styles.empty}>
                {`Nothing matches \u201c${query.trim()}\u201d.`}
              </Text>
            ) : null}
            {shown.map((entry) => sectionRow(entry, false))}
          </>
        ) : (
          <>
            <Text variant="railHead" style={styles.group}>
              Your account
            </Text>
            {sections
              .filter((entry) => entry.scope === "account")
              .map((entry) => sectionRow(entry, false))}
            {contextGroup("Brains", "personal")}
            {contextGroup("Workspaces", "shared")}
          </>
        )}
      </ScrollView>
    </View>
  );

  const chosen = sections.find((entry) => entry.key === active);
  /*
    The binding's health, which the pane's own head used to carry ahead of
    everything because it qualifies every control below it. Sectioning skips
    that head, and the top bar's storage chip is pointer-only — so without this
    a phone states the health of the bucket nowhere at all.
  */
  const health = data.storage ? <StatusPill storage={data.storage} /> : null;

  /*
    An account section is about the person, so it carries neither the context
    badge nor the binding's health — both would be naming a scope the section
    is not in, which is the mistake `ConnectionsPane`'s own head comment
    records about wearing a context chip on an app-level pane.
  */
  /*
    Map and Connections, which are console destinations rather than settings.

    Drawn here rather than inside `SettingsPane` because `features/app/
    reachability.ts` registers this list as the **only** surface `/console/map`
    is reachable from — and while it lived in the pane, opening an account
    section took a different branch and Map disappeared from the product until
    you clicked back to a context one. Chrome that flickers in and out with no
    rule the reader can infer is worse than either state.
  */
  const elsewhere =
    onOpenSection === undefined ? null : (
      <View style={styles.elsewhere}>
        <Text variant="railHead" style={styles.group}>
          Elsewhere in the console
        </Text>
        <Card>
          {appSectionsFor(data.searchableContexts).map((entry, index) => (
            <Row key={entry.key} divided={index > 0}>
              <Grow>
                <Text variant="rowTitle">{entry.label}</Text>
                <Text variant="rowSub" style={styles.elsewhereSub}>
                  {SECTION_BLURBS[entry.key]}
                </Text>
              </Grow>
              <Button
                label="Open"
                accessibilityLabel={`Open ${entry.label}`}
                onPress={() => onOpenSection(entry.key)}
                testID={`settings-open-${entry.key}`}
              />
            </Row>
          ))}
        </Card>
      </View>
    );

  const body = account ? (
    <AccountSection
      section={active}
      data={data}
      onSignOut={onSignOut}
      onOpenInvitation={onOpenInvitation}
    />
  ) : (
    <SettingsPane data={data} onClose={onDismiss} section={active} />
  );

  if (compact) {
    return (
      <Overlay
        title={listing ? "Settings" : (chosen?.label ?? "Settings")}
        badge={account || !current ? null : <Pill tone="neutral">{atName(current.slug)}</Pill>}
        trailing={listing || account ? null : health}
        closeLabel="Close settings"
        onBack={listing ? undefined : () => setListing(true)}
        onDismiss={onDismiss}
        testID="settings-overlay"
      >
        {listing ? (
          list
        ) : (
          <ScrollView
            contentContainerStyle={styles.body}
            keyboardShouldPersistTaps="handled"
          >
            {body}
            {elsewhere}
          </ScrollView>
        )}
      </Overlay>
    );
  }

  return (
    <Overlay
      title="Settings"
      badge={account || !current ? null : <Pill tone="neutral">{atName(current.slug)}</Pill>}
      trailing={account ? null : health}
      closeLabel="Close settings"
      sidebar={list}
      onDismiss={onDismiss}
      testID="settings-overlay"
    >
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {body}
        {elsewhere}
      </ScrollView>
    </Overlay>
  );
}

/**
 * What each re-homed pane is for, said once.
 *
 * A row that is only a name is a row people press to find out what it does,
 * which on a settings page is a navigation somebody has to come back from.
 */
const SECTION_BLURBS: Record<AppSectionKey, string> = {
  search: "One search across every context you can reach, with a scope you can narrow.",
  map: "Every context you can reach, and every AI app connected to one, as a diagram.",
  connections:
    "The address, and the apps holding a grant. Revoke one without disturbing the others.",
};

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sideWrap: { flex: 1, minHeight: 0 },
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
    side: { paddingBottom: space.x4, paddingHorizontal: space.x3 },
    empty: { paddingHorizontal: space.x2, paddingVertical: space.x3 },
    elsewhere: { marginTop: space.x7 },
    elsewhereSub: { marginTop: 2, maxWidth: 460 },
    group: { marginTop: space.x4, marginBottom: space.x2, paddingHorizontal: space.x2 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: 7,
      paddingHorizontal: 9,
      borderRadius: radii.md,
    },
    /*
      A section belongs to the context row above it, and indentation is the
      only thing that says so — the group headings between them are the
      context's, not the list's.
    */
    rowIndent: { marginLeft: space.x3 },
    rowTrailing: { marginLeft: "auto", color: colors.muted },
    groupIndent: { paddingLeft: space.x4 },
    /*
      7pt around a ~21pt line is 35 — right there and wrong under a thumb, in
      the arithmetic `ConsoleRail` already wrote down. On a phone this list is
      the only way to another section, so it takes the touch minimum.
    */
    rowTouch: {
      minHeight: layout.minTouchTarget,
      paddingVertical: space.x3,
      justifyContent: "center",
    },
    rowOn: { backgroundColor: colors.accentDim },
    /*
      A lit context is not a lit section. Both stack directly on top of each
      other — the open context, then whichever of its sections is showing — and
      two accent bands read as one selection spanning both.
    */
    contextOn: { backgroundColor: colors.surface3 },
    labelOn: { color: colors.accentText },
    body: { padding: space.x6, paddingBottom: space.x8 },
  });
