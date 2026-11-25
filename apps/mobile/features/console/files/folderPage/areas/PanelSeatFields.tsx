/**
 * The side panel's editable rows, drawn as the owner's prototype draws them
 * (the owner, 2026-11-24: "why cant I make changes inline? wth is the point of
 * a side panel if its just going to link to this ugly pop up"): Owner and
 * Helper as values that drop a menu, the modes as chips, and the holder's
 * card (phone, email, whether Tex answers for them; or an agent's access and
 * vault item) as fields typed where they are drawn. Then the approval rules,
 * one line each, and the area's notes.
 *
 * Every choice is written as it is made, through the same save the seat
 * pop-up uses; typed text is written when it loses focus. Nothing here opens
 * a pop-up.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";
import { Icon, type IconName } from "../../../../design/components/Icon";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MenuItem } from "../../menuItem";
import type { OwnerSearch } from "../../owners";
import { displayName } from "../../paths";
import { OwnerFace, type Face } from "../Glyphs";
import type { ItemEntry } from "../model";
import { MODES, MODE_TIPS, fileKind, type Card, type Mode, type Seat, type SeatEdit } from "./seat";

/** What the panel needs to edit an owner where it is drawn. */
export interface PanelSeatTools {
  people: OwnerSearch;
  agents: readonly string[];
  isAgent: (owner: string) => boolean;
  cardFor: (holder: string, kind: Card["kind"]) => Card;
  label: (owner: string) => string;
}

export type PanelWrite = (patch: Partial<SeatEdit>, cards?: readonly Card[]) => void;

type Anchor = { x: number; y: number } | null;
const NOBODY = "__nobody__";

/** The workspace's people, asked once when a menu opens. */
function usePeopleList(search: OwnerSearch, asking: boolean): readonly string[] {
  const [people, setPeople] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!asking) return;
    let live = true;
    search("", [])
      .then((found) => live && setPeople(found.people.map((person) => person.value)))
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [search, asking]);
  return people;
}

/** Owner, helper, modes and how to reach the holder, as label and value rows. */
export function PanelOwnerRows({
  seat,
  tools,
  canEdit,
  faceOf,
  inherited,
  write,
}: {
  seat: Seat;
  tools: PanelSeatTools;
  canEdit: boolean;
  faceOf: (owner: string | null) => Face;
  /** "Held through Leadership", when the owner comes from an area above. */
  inherited: string | null;
  write: PanelWrite;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { people, agents, isAgent, cardFor, label } = tools;
  const [menu, setMenu] = useState<{ which: "owner" | "helper"; anchor: Anchor } | null>(null);
  const known = usePeopleList(people, menu?.which === "owner");
  const owner = seat.owner;
  const ownerIsAgent = owner !== null && isAgent(owner);
  const helper = seat.helper;
  const card = owner === null ? null : cardFor(owner, ownerIsAgent ? "agent" : "person");
  const writeCard = (patch: Partial<Card>) => {
    if (card === null) return;
    const next = { ...card, ...patch };
    if (JSON.stringify(next) !== JSON.stringify(card)) write({}, [next]);
  };
  const toggleMode = (mode: Mode) => write({ modes: seat.modes.includes(mode) ? seat.modes.filter((each) => each !== mode) : [...seat.modes, mode] });

  const same = (a: string | null, b: string) => a !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
  const ownerItems: MenuItem<string>[] =
    menu?.which === "owner"
      ? [
          ...unique([...(owner === null ? [] : [owner]), ...known]).filter((word) => !isAgent(word)).map((word) => ({ id: word, label: label(word), checked: same(owner, word) })),
          ...agents.map((agent, at) => ({ id: agent, label: label(agent), detail: "Agent", checked: same(owner, agent), ...(at === 0 ? { separatorBefore: true } : {}) })),
          { id: NOBODY, label: "Nobody", checked: owner === null, separatorBefore: true },
        ]
      : [
          { id: NOBODY, label: "None", checked: helper === null },
          ...agents.map((agent) => ({ id: agent, label: label(agent), checked: same(helper, agent) })),
        ];
  const choose = (id: string) => {
    const which = menu?.which;
    setMenu(null);
    const word = id === NOBODY ? null : id;
    // An agent holding the seat has no helper of its own.
    if (which === "owner") write({ owner: word, ...(word !== null && isAgent(word) ? { helper: null } : {}) });
    else write({ helper: word });
  };

  return (
    <View style={styles.grid}>
      <Row label="Owner">
        <DropValue editable={canEdit} label="Change owner" onOpen={(anchor) => setMenu({ which: "owner", anchor })} testID="area-panel-owner">
          <OwnerFace face={faceOf(owner)} size={18} />
          <Text variant="tree" style={[styles.value, owner === null && styles.muted]} numberOfLines={1}>
            {owner === null ? "Nobody yet" : label(owner)}
          </Text>
        </DropValue>
      </Row>
      {inherited === null ? null : <Text variant="treeMeta" style={[styles.muted, styles.under]}>{inherited}</Text>}
      {ownerIsAgent ? null : (
        <Row label="Helper">
          <DropValue editable={canEdit} label="Change helper" onOpen={(anchor) => setMenu({ which: "helper", anchor })} testID="area-panel-helper">
            <Text variant="tree" style={[styles.value, helper === null && styles.muted]} numberOfLines={1}>
              {helper === null ? "None" : label(helper)}
            </Text>
          </DropValue>
        </Row>
      )}
      <Row label="Modes">
        <View style={styles.modes} role="group" aria-label="Modes">
          {MODES.map((mode) => {
            const on = seat.modes.includes(mode);
            return (
              <Pressable
                key={mode}
                onPress={canEdit ? () => toggleMode(mode) : undefined}
                disabled={!canEdit}
                aria-pressed={on}
                role="button"
                accessibilityLabel={`${mode} mode`}
                accessibilityHint={MODE_TIPS[mode]}
                style={[styles.mode, on && styles.modeOn]}
                testID={`area-panel-mode-${mode}`}
              >
                <Text variant="treeMeta" style={on ? styles.modeWordOn : styles.modeWord}>{mode}</Text>
              </Pressable>
            );
          })}
        </View>
      </Row>
      {card === null || owner === null ? null : ownerIsAgent ? (
        <>
          <Row label="Reach">
            <InlineField value={card.access} label="Where and how to reach it" placeholder={canEdit ? "Where and how to reach it" : "Not set"} editable={canEdit} onCommit={(access) => writeCard({ access })} style={styles.field} testID="area-panel-access" />
          </Row>
          <Row label="Vault">
            <InlineField value={card.vault} label="Vault item with the login" placeholder={canEdit ? "The vault item's name" : "Not set"} editable={canEdit} onCommit={(vault) => writeCard({ vault })} style={styles.field} testID="area-panel-vault" />
          </Row>
        </>
      ) : (
        <>
          <Row label="Phone">
            <InlineField value={card.phone} label="Phone" placeholder={canEdit ? "Add a number" : "Not set"} editable={canEdit} onCommit={(phone) => writeCard({ phone })} style={styles.field} keyboard="phone-pad" testID="area-panel-phone" />
          </Row>
          <Row label="Email">
            <InlineField value={card.email} label="Email" placeholder={canEdit ? "Add an email" : "Not set"} editable={canEdit} onCommit={(email) => writeCard({ email })} style={styles.field} keyboard="email-address" testID="area-panel-email" />
          </Row>
          <Row label="Tex">
            <Pressable
              role="checkbox"
              aria-checked={card.delegation.trim().toLowerCase() === "tex"}
              disabled={!canEdit}
              onPress={() => writeCard({ delegation: card.delegation.trim().toLowerCase() === "tex" ? "" : "Tex" })}
              style={styles.check}
              testID="area-panel-tex"
            >
              <View style={[styles.box, card.delegation.trim().toLowerCase() === "tex" && styles.boxOn]}>
                {card.delegation.trim().toLowerCase() === "tex" ? <Icon name="check" size={11} color={colors.surface} /> : null}
              </View>
              <Text variant="tree" style={styles.value} numberOfLines={1}>{`Answers for ${label(owner)}`}</Text>
            </Pressable>
          </Row>
        </>
      )}
      {owner === null ? null : (
        <Text variant="treeMeta" style={[styles.muted, styles.hint]}>{`How to reach ${label(owner)} is one card, shown on every area they hold.`}</Text>
      )}
      {menu === null ? null : (
        <Menu<string>
          items={ownerItems}
          {...(menu.anchor === null ? {} : { anchor: menu.anchor })}
          title={menu.which === "owner" ? "Owner" : "Helper"}
          onSelect={choose}
          onDismiss={() => setMenu(null)}
        />
      )}
    </View>
  );
}

function unique(words: readonly string[]): string[] {
  const seen = new Set<string>();
  return words.filter((word) => {
    const key = word.trim().toLowerCase();
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text variant="tree" style={styles.key}>{label}</Text>
      <View style={styles.cell}>{children}</View>
    </View>
  );
}

/** A value with a chevron that drops its menu under itself. */
function DropValue({ editable, label, onOpen, testID, children }: { editable: boolean; label: string; onOpen: (anchor: Anchor) => void; testID: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const node = useRef<View>(null);
  if (!editable) return <View style={styles.drop}>{children}</View>;
  return (
    <View ref={node} collapsable={false} style={styles.dropWrap}>
      <Pressable
        onPress={() => {
          if (node.current?.measureInWindow === undefined) onOpen(null);
          else node.current.measureInWindow((x, y, _width, height) => onOpen({ x, y: y + height + 4 }));
        }}
        role="button"
        aria-haspopup="menu"
        accessibilityLabel={label}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.drop, styles.dropPress, hovered && styles.hover]}
        testID={testID}
      >
        {children}
        <Icon name="chevronDown" size={14} color={colors.text2} />
      </Pressable>
    </View>
  );
}

/** Text that is edited where it is drawn, written when it loses focus or on Enter. */
export function InlineField({
  value,
  label,
  placeholder,
  editable,
  onCommit,
  style,
  keyboard,
  multiline = false,
  testID,
}: {
  value: string;
  label: string;
  placeholder: string;
  editable: boolean;
  onCommit: (text: string) => void;
  style: TextStyle;
  keyboard?: "phone-pad" | "email-address";
  multiline?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => setText(value), [value]);
  const fieldFont = useFieldFont(style.fontSize);
  const commit = () => {
    if (text.trim() !== value.trim()) onCommit(text.trim());
  };
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onSubmitEditing={commit}
      editable={editable}
      multiline={multiline}
      {...(multiline ? { blurOnSubmit: true } : {})}
      {...(keyboard === undefined ? {} : { keyboardType: keyboard, autoCapitalize: "none" as const, autoCorrect: false })}
      accessibilityLabel={label}
      placeholder={placeholder}
      placeholderTextColor={colors.muted}
      style={[styles.input, editable && styles.inputEditable, focused && styles.inputFocused, style, fieldFont]}
      testID={testID}
    />
  );
}

/** The rules agents read before they act, one line each, edited where they are drawn. */
export function PanelRules({ seat, canEdit, write }: { seat: Seat; canEdit: boolean; write: PanelWrite }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [adding, setAdding] = useState(false);
  const rules = seat.approvals;
  const put = (index: number, text: string) => {
    const next = [...rules];
    if (text.trim() === "") next.splice(index, 1);
    else next[index] = text.trim();
    write({ approvals: next });
  };
  return (
    <View style={styles.rules}>
      {rules.map((rule, index) => (
        <View key={`${index}:${rule}`} style={styles.ruleRow}>
          <InlineField value={rule} label="Approval rule" placeholder="A rule" editable={canEdit} multiline onCommit={(text) => put(index, text)} style={styles.rule} testID={`area-panel-rule-${index}`} />
          {canEdit ? (
            <Pressable role="button" accessibilityLabel="Remove rule" onPress={() => put(index, "")} hitSlop={6} style={styles.remove} testID={`area-panel-rule-remove-${index}`}>
              <Icon name="close" size={11} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
      ))}
      {adding ? (
        <NewRule
          onDone={(text) => {
            setAdding(false);
            if (text.trim() !== "") write({ approvals: [...rules, text.trim()] });
          }}
        />
      ) : canEdit ? (
        <Pressable role="button" onPress={() => setAdding(true)} style={styles.add} testID="area-panel-add-rule">
          <Text variant="treeMeta" style={styles.link}>+ Add a rule</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function NewRule({ onDone }: { onDone: (text: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [text, setText] = useState("");
  const fieldFont = useFieldFont(pointerType.meta);
  return (
    <TextInput
      value={text}
      onChangeText={setText}
      onBlur={() => onDone(text)}
      onSubmitEditing={() => onDone(text)}
      autoFocus
      accessibilityLabel="New approval rule"
      placeholder="e.g. Spending over $20 needs the owner's approval."
      placeholderTextColor={colors.muted}
      style={[styles.input, styles.inputFocused, styles.rule, fieldFont]}
      testID="area-panel-rule-new"
    />
  );
}

const KIND_ICON: Record<ReturnType<typeof fileKind>, IconName> = { folder: "folder", note: "file", page: "file", sheet: "grid", file: "file" };
const KIND_WORD: Record<ReturnType<typeof fileKind>, string> = { folder: "folder", page: "Page", sheet: "CSV", note: "", file: "" };

/** The area's own notes, pages, sheets and folders; one press opens one. */
export function PanelNotes({ files, onOpen }: { files: readonly ItemEntry[]; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View>
      {files.map((entry) => {
        const kind = fileKind(entry);
        const name = displayName(entry.name).replace(/\.page$/, "");
        return (
          <Pressable
            key={entry.path}
            onPress={() => onOpen(entry.path)}
            role="link"
            accessibilityLabel={name}
            style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.note, hovered && styles.hover]}
            testID={`area-panel-note-${entry.path}`}
          >
            <Icon name={KIND_ICON[kind]} size={14} color={colors.muted} />
            <Text variant="tree" style={styles.noteName} numberOfLines={1}>{name}</Text>
            {KIND_WORD[kind] === "" ? null : <Text variant="treeMeta" style={styles.muted}>{KIND_WORD[kind]}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

const KEY_WIDTH = 64;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    grid: { gap: space.x2 },
    row: { flexDirection: "row", alignItems: "center", minHeight: 28, gap: space.x2 },
    key: { width: KEY_WIDTH, color: colors.text2 },
    cell: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
    under: { marginLeft: KEY_WIDTH + space.x2 },
    hint: { marginTop: space.x1 },
    muted: { color: colors.muted },
    value: { flexShrink: 1, minWidth: 0, color: colors.text },
    // Only as wide as the value, so its hover is not a bar across the panel.
    dropWrap: { alignSelf: "flex-start", maxWidth: "100%" },
    drop: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 26 },
    dropPress: { paddingHorizontal: 6, marginLeft: -6, borderRadius: radii.sm, justifyContent: "flex-start" },
    hover: { backgroundColor: colors.chipFill },
    modes: { flexDirection: "row", flexWrap: "wrap", gap: space.x1 },
    mode: { paddingVertical: 2, paddingHorizontal: space.x3, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.muted },
    modeOn: { backgroundColor: colors.text, borderColor: colors.text },
    modeWord: { color: colors.text2 },
    modeWordOn: { color: colors.surface },
    field: { fontSize: pointerType.ui },
    input: {
      fontFamily: fonts.body,
      color: colors.text,
      paddingVertical: 3,
      paddingHorizontal: 6,
      marginLeft: -6,
      borderWidth: 1,
      borderColor: "transparent",
      borderRadius: radii.sm,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
    },
    inputEditable: {},
    inputFocused: { borderColor: colors.accent, backgroundColor: colors.surface },
    check: { flexDirection: "row", alignItems: "center", gap: space.x2, alignSelf: "flex-start" },
    box: { width: 15, height: 15, borderRadius: 3, borderWidth: 1, borderColor: colors.lineStrong, alignItems: "center", justifyContent: "center" },
    boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    rules: { gap: space.x1 },
    ruleRow: { flexDirection: "row", alignItems: "flex-start", gap: space.x1 },
    rule: { flexGrow: 1, flexShrink: 1, minWidth: 0, fontSize: pointerType.meta },
    remove: { padding: space.x1, marginTop: 2, borderRadius: radii.sm },
    add: { alignSelf: "flex-start", paddingVertical: 2 },
    link: { color: colors.accent },
    note: { flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: 30, paddingHorizontal: space.x1, marginHorizontal: -space.x1, borderRadius: radii.sm },
    noteName: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  });
