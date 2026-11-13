import { useCallback, useEffect, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { api } from "@context/convex/_generated/api";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { useCopy } from "../../../design/useCopy";
import { useColors, type Colors } from "../../../design/theme";
import { fonts, pointerType, settingsHomeType } from "../../../design/tokens";
import { atName } from "../../format";
import { useWorkspaceIcons } from "../../useWorkspaceIcons";
import { WorkspaceMark } from "../../WorkspaceMark";
import { selectedContext, type ConsoleContext, type ConsoleData } from "../../types";
import { AppearancePicker } from "../panels/AppearancePicker";
import { downloadEverything } from "../downloadEverything";
import { LiveRowValueSource, type LiveRowValues } from "../liveRowValues";
import type { SettingsSectionKey, SettingsSectionSpec } from "../sections";
import { settingsHome, type HomeRow, type HomeSection } from "./homeModel";

/**
 * The settings home's palette: the app's own, so the page reads as the same
 * app as the notes behind it (Dev2, 2026-11-12: the landing page's paper "does
 * not match the rest of the app"). Tiles take the app's washes.
 */
export function useHomeColors(): HomeColors {
  return homeColorsFor(useColors());
}

export interface HomeColors {
  ground: string;
  text: string;
  muted: string;
  hair: string;
  buttonLine: string;
  blue: string;
  danger: string;
  dangerWash: string;
  tiles: Record<"peach" | "sage" | "butter" | "lilac" | "sky" | "tint", string>;
  tileInk: string;
}

const homeColorCache = new WeakMap<Colors, HomeColors>();
function homeColorsFor(c: Colors): HomeColors {
  let out = homeColorCache.get(c);
  if (out === undefined) {
    out = {
      ground: c.ground,
      text: c.text,
      muted: c.muted,
      hair: c.line,
      buttonLine: c.lineStrong,
      blue: c.accentText,
      danger: c.critText,
      dangerWash: c.critWash,
      tiles: { peach: c.warnWash, sage: c.okWash, butter: c.markWash, lilac: c.sharedWash, sky: c.hintWash, tint: c.chipFill },
      tileInk: c.text,
    };
    homeColorCache.set(c, out);
  }
  return out;
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
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      testID="settings-sections"
    >
      {live && current !== null ? <LiveRowValueSource workspaceId={current.id} onValues={onValues} /> : null}
      {live ? <TexLineSource onLine={setTexLine} /> : null}
      <View style={styles.page}>
        <Text role="heading" aria-level={1} style={styles.h1} testID="settings-home-title">
          Settings
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
  const current = selectedContext(data);
  return (
    <View style={styles.section} testID={`settings-group-${section.id}`}>
      <Text role="heading" aria-level={2} style={styles.h2}>
        {section.title}
      </Text>
      {section.scope === "workspace" && current !== null ? (
        <WorkspacePicker
          contexts={data.contexts}
          current={current}
          onSwitch={(slug) => {
            if (slug !== current.slug) onSwitchContext?.(slug);
          }}
        />
      ) : null}
      <View>
        {section.rows.map((entry, index) => (
          <Row key={entry.id} row={entry} divided={index > 0 || section.scope === "workspace"} data={data} onSelect={onSelect} onSignOut={onSignOut} />
        ))}
      </View>
    </View>
  );
}

/** "Shared · Owner": what kind of workspace, and what this person can do in it. */
export function workspaceCaption(context: ConsoleContext): string {
  const kind = context.kind === "shared" ? "Shared" : context.role === "owner" ? "Personal" : "Someone else's";
  const role = context.role === "owner" ? "Owner" : context.role === "editor" ? "Can edit" : "View only";
  return `${kind} · ${role}`;
}

/**
 * Every workspace this person has, at the head of the page: the one picked is
 * the one the "This workspace" section shows, and picking another switches the
 * app to it, the same switch as the account menu's.
 */
function WorkspacePicker({
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
  const iconFor = useWorkspaceIcons();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Workspace ${atName(current.slug)}`}
        aria-expanded={open}
        aria-haspopup="menu"
        onPress={() => setOpen((was) => !was)}
        style={styles.pick}
        testID="settings-workspace-switcher"
      >
        <WorkspaceMark label={atName(current.slug)} tone={current.status} icon={iconFor(current)} />
        <View style={styles.grow}>
          <View style={styles.pickName}>
            <Text style={styles.pickLabel} numberOfLines={1}>
              {atName(current.slug)}
            </Text>
            <Icon name={open ? "chevronUp" : "chevronDown"} size={14} color={c.muted} />
          </View>
          <Text style={styles.line}>{workspaceCaption(current)}</Text>
        </View>
      </Pressable>
      {open ? (
        <View style={styles.menu} role="menu" aria-label="Workspace">
          {contexts.map((context) => {
            const here = context.id === current.id;
            return (
              <Pressable
                key={context.id}
                role="menuitem"
                aria-checked={here}
                aria-current={here}
                accessibilityLabel={atName(context.slug)}
                onPress={() => {
                  setOpen(false);
                  onSwitch(context.slug);
                }}
                style={styles.option}
                testID={`settings-context-${context.slug}`}
              >
                <WorkspaceMark label={atName(context.slug)} tone={context.status} icon={iconFor(context)} />
                <View style={styles.grow}>
                  <Text style={styles.title} numberOfLines={1}>
                    {atName(context.slug)}
                  </Text>
                  <Text style={styles.line}>{workspaceCaption(context)}</Text>
                </View>
                {here ? <Icon name="check" size={14} color={c.text} /> : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}
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
      <RowAction row={row} data={data} onSignOut={onSignOut} />
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
  onSignOut,
}: {
  row: HomeRow;
  data: ConsoleData;
  onSignOut?: () => void;
}) {
  const c = useHomeColors();
  const styles = makeStyles(c);
  const action = row.action;
  switch (action.kind) {
    case "open":
      /* The whole row is the button; its label is drawn as one, never a button inside a button. */
      return (
        <View style={[styles.button, action.danger ? styles.buttonDanger : null]} testID={`settings-action-${row.id}`}>
          <Text style={[styles.buttonLabel, action.danger ? styles.buttonLabelDanger : null]}>{action.label}</Text>
        </View>
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
      return <Text style={styles.byText}>Text Tex</Text>;
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

const cache = new Map<HomeColors, ReturnType<typeof build>>();
function makeStyles(c: HomeColors) {
  let styles = cache.get(c);
  if (styles === undefined) {
    styles = build(c);
    cache.set(c, styles);
  }
  return styles;
}

function build(c: HomeColors) {
  return StyleSheet.create({
    scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 72 },
    page: { width: "100%", maxWidth: 600, alignSelf: "center", gap: 44 },
    h1: { fontFamily: fonts.body, fontSize: settingsHomeType.heading, lineHeight: 28, fontWeight: "600", color: c.text, marginBottom: -20 },
    section: { gap: 4 },
    h2: { fontFamily: fonts.body, fontSize: pointerType.lede, lineHeight: 24, fontWeight: "600", color: c.text, marginBottom: 2 },
    pick: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, alignSelf: "flex-start" },
    pickName: { flexDirection: "row", alignItems: "center", gap: 6 },
    pickLabel: { fontFamily: fonts.body, fontSize: pointerType.lede, lineHeight: 22, fontWeight: "600", color: c.text },
    menu: {
      borderWidth: 1,
      borderColor: c.buttonLine,
      borderRadius: 12,
      padding: 4,
      marginBottom: 8,
      backgroundColor: c.ground,
    },
    option: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 8, borderRadius: 8 },
    row: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, minHeight: 56 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hair },
    mark: { width: 20, alignItems: "center" },
    tile: { width: 26, height: 26, borderRadius: 7, alignItems: "center", justifyContent: "center", marginHorizontal: -3 },
    tileRound: { width: 34, height: 34, borderRadius: 17, marginHorizontal: -7 },
    tileLetter: { fontFamily: fonts.body, fontSize: pointerType.meta, fontWeight: "600", color: c.tileInk },
    grow: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontFamily: fonts.body, fontSize: pointerType.lede, lineHeight: 20, color: c.text },
    line: { fontFamily: fonts.body, fontSize: pointerType.ui, lineHeight: 18, color: c.muted },
    button: {
      borderWidth: 1,
      borderColor: c.buttonLine,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    buttonDanger: { borderColor: "transparent", backgroundColor: c.dangerWash },
    buttonLabel: { fontFamily: fonts.body, fontSize: pointerType.ui, lineHeight: 17, fontWeight: "500", color: c.text },
    buttonLabelDanger: { color: c.danger },
    copy: { minWidth: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 8 },
    byText: { fontFamily: fonts.body, fontSize: pointerType.meta, color: c.muted },
  });
}
