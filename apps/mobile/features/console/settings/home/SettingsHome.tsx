import { useCallback, useEffect, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { api } from "@context/convex/_generated/api";
import { Dot } from "../../../design/components/Dot";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useCopy } from "../../../design/useCopy";
import { useScheme } from "../../../design/theme";
import { fonts } from "../../../design/tokens";
import { settingsHomeColors, type SettingsHomeColors } from "../../../design/tokens/settingsHomeColors";
import { atName } from "../../format";
import { selectedContext, type ConsoleContext, type ConsoleData } from "../../types";
import { AppearancePicker } from "../panels/AppearancePicker";
import { downloadEverything } from "../downloadEverything";
import { LiveRowValueSource, type LiveRowValues } from "../liveRowValues";
import type { SettingsSectionKey, SettingsSectionSpec } from "../sections";
import { settingsHome, type HomeRow, type HomeSection } from "./homeModel";

/** The settings home's palette for the scheme on screen. */
export function useHomeColors(): SettingsHomeColors {
  return settingsHomeColors[useScheme()];
}

/**
 * Settings as one page: every section on one scroll, each row a name, one line
 * and one action (Dev2, 2026-11-12; `homeModel.ts` holds what it says and
 * why). Pressing a row's action that opens a page asks for that section, the
 * same `onSelect` the old index used, so every panel and every
 * `?settings=<key>` link is unchanged.
 */
export function SettingsHome({
  data,
  sections,
  onSelect,
  onSwitchContext,
  onSignOut,
}: {
  data: ConsoleData;
  sections: readonly SettingsSectionSpec[];
  onSelect: (key: SettingsSectionKey) => void;
  onSwitchContext?: (slug: string) => void;
  onSignOut?: () => void;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  const current = selectedContext(data);
  const client = useConvex();
  const live = !data.demo && client !== undefined;
  const [values, setValues] = useState<LiveRowValues>({});
  const onValues = useCallback((next: LiveRowValues) => setValues(next), []);
  const [texLine, setTexLine] = useState<string | null>(null);
  const home = settingsHome({
    data,
    sections,
    texLine,
    live: values,
    canSignOut: onSignOut !== undefined,
  });
  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      testID="settings-sections"
    >
      {live && current !== null ? <LiveRowValueSource workspaceId={current.id} onValues={onValues} /> : null}
      {live ? <TexLineSource onLine={setTexLine} /> : null}
      <View style={styles.page}>
        <Text role="heading" aria-level={1} style={styles.h1} testID="settings-home-title">
          Settings<Text style={styles.period}>.</Text>
        </Text>
        {home.map((section) => (
          <Section
            key={section.id}
            section={section}
            data={data}
            onSelect={onSelect}
            onSwitchContext={onSwitchContext}
            onSignOut={onSignOut}
          />
        ))}
      </View>
    </ScrollView>
  );
}

/** Reads this person's Tex line. Mounted only where there is a client. */
function TexLineSource({ onLine }: { onLine: (line: string | null) => void }) {
  const home = useQuery(api.functions.texHome.mine, {});
  const line = home?.line ?? null;
  useEffect(() => onLine(line), [line, onLine]);
  return null;
}

function Section({
  section,
  data,
  onSelect,
  onSwitchContext,
  onSignOut,
}: {
  section: HomeSection;
  data: ConsoleData;
  onSelect: (key: SettingsSectionKey) => void;
  onSwitchContext?: (slug: string) => void;
  onSignOut?: () => void;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  const [moreOpen, setMoreOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const current = selectedContext(data);
  const row = (entry: HomeRow, index: number, divided: boolean) => (
    <Row
      key={entry.id}
      row={entry}
      divided={divided || index > 0}
      data={data}
      onSelect={onSelect}
      onSignOut={onSignOut}
    />
  );
  return (
    <View style={styles.section} testID={`settings-group-${section.id}`}>
      <View style={styles.head}>
        <Text role="heading" aria-level={2} style={styles.h2}>
          {section.title}
        </Text>
        {section.lede === undefined ? null : (
          <Text style={styles.lede}>
            {section.lede}
            {section.switcher === true && data.contexts.length > 1 ? (
              <>
                {" "}
                <Text
                  role="button"
                  aria-expanded={switching}
                  onPress={() => setSwitching((was) => !was)}
                  style={styles.inlineLink}
                  testID="settings-workspace-switcher"
                >
                  Switch workspace
                </Text>
              </>
            ) : null}
          </Text>
        )}
        {switching && current !== null ? (
          <WorkspaceMenu
            contexts={data.contexts}
            current={current}
            onSwitch={(slug) => {
              setSwitching(false);
              if (slug !== current.slug) onSwitchContext?.(slug);
            }}
          />
        ) : null}
      </View>
      <View>
        {section.rows.map((entry, index) => row(entry, index, false))}
        {section.more === undefined ? null : (
          <>
            <Pressable
              accessibilityRole="button"
              aria-expanded={moreOpen}
              onPress={() => setMoreOpen((was) => !was)}
              style={[styles.more, section.rows.length > 0 ? styles.divided : null]}
              testID={`settings-more-${section.id}`}
            >
              <Text style={[styles.moreLabel, section.rows.some((r) => r.icon !== undefined || r.tile !== undefined) ? styles.indent : null]}>
                {moreOpen ? "Show less" : section.more.label}
              </Text>
              <Icon name={moreOpen ? "chevronUp" : "chevronDown"} size={12} color={c.blue} />
            </Pressable>
            {moreOpen ? section.more.rows.map((entry) => row(entry, 1, true)) : null}
          </>
        )}
      </View>
    </View>
  );
}

function WorkspaceMenu({
  contexts,
  current,
  onSwitch,
}: {
  contexts: readonly ConsoleContext[];
  current: ConsoleContext;
  onSwitch: (slug: string) => void;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  return (
    <View style={styles.menu} testID="settings-workspace-menu">
      {contexts.map((context) => {
        const here = context.id === current.id;
        return (
          <Pressable
            key={context.id}
            accessibilityRole="button"
            accessibilityState={{ selected: here }}
            aria-current={here ? "true" : undefined}
            accessibilityLabel={atName(context.slug)}
            onPress={() => onSwitch(context.slug)}
            style={styles.menuRow}
            testID={`settings-context-${context.slug}`}
          >
            <Dot tone={context.status} />
            <Text style={styles.title} numberOfLines={1}>
              {atName(context.slug)}
            </Text>
            <View style={styles.grow} />
            <Text style={styles.line}>{context.kind === "shared" ? "Shared" : "Personal"}</Text>
            {here ? <Icon name="check" size={13} color={c.blue} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function Row({
  row,
  divided,
  data,
  onSelect,
  onSignOut,
}: {
  row: HomeRow;
  divided: boolean;
  data: ConsoleData;
  onSelect: (key: SettingsSectionKey) => void;
  onSignOut?: () => void;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  const action = row.action;
  /*
    A row that opens a page is pressable across its whole width, not only on
    its button: the button says what happens, the row is the target a thumb
    actually lands on. In-place actions keep to their own control, so a stray
    tap on the words never signs anybody out.
  */
  const opens = action.kind === "open" ? () => onSelect(action.key) : undefined;
  const body = (
    <>
      {row.tile !== undefined ? (
        <View
          style={[styles.tile, row.tile.round ? styles.tileRound : null, { backgroundColor: c.tiles[row.tile.tone] }]}
          aria-hidden
        >
          <Text style={styles.tileLetter}>{row.tile.letter}</Text>
        </View>
      ) : row.icon !== undefined ? (
        <View style={styles.mark} aria-hidden>
          <Icon name={row.icon} size={18} color={c.text} />
        </View>
      ) : null}
      <View style={styles.grow}>
        <Text style={styles.title} numberOfLines={2}>
          {row.title}
        </Text>
        {row.line === null ? null : <Text style={styles.line}>{row.line}</Text>}
      </View>
      <RowAction row={row} data={data} onSelect={onSelect} onSignOut={onSignOut} />
    </>
  );
  if (opens !== undefined) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={row.title}
        onPress={opens}
        style={[styles.row, divided ? styles.divided : null]}
        testID={`settings-section-${row.id}`}
      >
        {body}
      </Pressable>
    );
  }
  return (
    <View style={[styles.row, divided ? styles.divided : null]} testID={`settings-row-${row.id}`}>
      {body}
    </View>
  );
}

function RowAction({
  row,
  data,
  onSelect,
  onSignOut,
}: {
  row: HomeRow;
  data: ConsoleData;
  onSelect: (key: SettingsSectionKey) => void;
  onSignOut?: () => void;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  const action = row.action;
  switch (action.kind) {
    case "open":
      return (
        <HomeButton
          label={action.label}
          danger={action.danger}
          onPress={() => onSelect(action.key)}
          testID={`settings-action-${row.id}`}
        />
      );
    case "copy":
      return <CopyButton text={action.text} label={`Copy ${row.title.toLowerCase()}`} testID={`settings-copy-${row.id}`} />;
    case "appearance":
      return <AppearancePicker />;
    case "download":
      return <HomeButton label="Download" onPress={() => downloadEverything(data)} testID="settings-download" />;
    case "signOut":
      return <HomeButton label="Sign out" onPress={() => onSignOut?.()} testID="settings-sign-out" />;
    case "byText":
      return <Text style={styles.byText}>By text</Text>;
    case "none":
      return null;
  }
}

function HomeButton({
  label,
  onPress,
  danger = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  testID?: string;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.button, danger ? styles.buttonDanger : null]}
      testID={testID}
    >
      <Text style={[styles.buttonLabel, danger ? styles.buttonLabelDanger : null]}>{label}</Text>
    </Pressable>
  );
}

function CopyButton({ text, label, testID }: { text: string; label: string; testID?: string }) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  const { label: state, copy } = useCopy(text, "Copy");
  const done = state !== "Copy";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={done ? state : label}
      onPress={copy}
      style={styles.copy}
      testID={testID}
    >
      {done ? <Text style={styles.byText}>{state}</Text> : <Icon name="copy" size={16} color={c.muted} />}
    </Pressable>
  );
}

const cache = new Map<SettingsHomeColors, ReturnType<typeof build>>();
function makeStyles(c: SettingsHomeColors) {
  let styles = cache.get(c);
  if (styles === undefined) {
    styles = build(c);
    cache.set(c, styles);
  }
  return styles;
}

function build(c: SettingsHomeColors) {
  return StyleSheet.create({
    scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 72 },
    page: { width: "100%", maxWidth: 560, alignSelf: "center", gap: 36 },
    h1: { fontFamily: fonts.reading, fontSize: 34, lineHeight: 40, color: c.text, marginBottom: -8 },
    period: { color: c.blue },
    section: { gap: 6 },
    head: { gap: 2 },
    h2: { fontFamily: fonts.reading, fontSize: 21, lineHeight: 28, color: c.text },
    lede: { fontFamily: fonts.body, fontSize: 13, lineHeight: 19, color: c.muted },
    inlineLink: { color: c.text, textDecorationLine: "underline" },
    row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 11, minHeight: 44 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hair },
    mark: { width: 20, alignItems: "center" },
    tile: { width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", marginHorizontal: -3 },
    tileRound: { width: 34, height: 34, borderRadius: 17, marginHorizontal: -7 },
    tileLetter: { fontFamily: fonts.body, fontSize: 12.5, fontWeight: "600", color: c.tileInk },
    grow: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontFamily: fonts.body, fontSize: 15, lineHeight: 20, color: c.text },
    line: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18, color: c.muted },
    button: {
      borderWidth: 1,
      borderColor: c.buttonLine,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    buttonDanger: { borderColor: "transparent", backgroundColor: c.dangerWash },
    buttonLabel: { fontFamily: fonts.body, fontSize: 13, lineHeight: 17, fontWeight: "500", color: c.text },
    buttonLabelDanger: { color: c.danger },
    copy: { minWidth: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 8 },
    byText: { fontFamily: fonts.body, fontSize: 12.5, color: c.muted },
    more: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 11 },
    moreLabel: { fontFamily: fonts.body, fontSize: 13, color: c.blue },
    indent: { marginLeft: 34 },
    menu: { marginTop: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: c.hair, borderRadius: 10, paddingHorizontal: 12 },
    menuRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  });
}
