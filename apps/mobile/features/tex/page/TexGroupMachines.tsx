import { StyleSheet, View } from "react-native";
import { Switch } from "../../design/components/Switch";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { ViewProps } from "./TexPageBody";
import { Button, DotLine, Glyph, GlyphSquare, RowLink, Stepper, type MachineGlyph } from "./TexMachineParts";
import { ListBox, SectionHead, T } from "./TexPageParts";
import { TexSelect, type SelectOption } from "./TexSelect";
import { useTexList, useTexMachines } from "./useTexPage";
import { dotOf, hereOf, whoLabel } from "./texMachineFormat";
import type { Machine, MachineChat, MachineState, MachineWho } from "./texMachineTypes";

/** The indent of a machine's own settings, under its header row, on every width. */
const NEST_INDENT = 38;
const PERSON = "person:";

/**
 * Group settings › Machines (design spec screen 4, `04-group-machines`). Each of
 * the person's connected machines, with its settings for this one group chat:
 * who may send it work, whether to ask first, and how many of its slots this
 * chat may use. A machine not yet in the chat gets one outlined button to add it.
 * Draws nothing when the gateway answers no machines, or none is connected.
 */
export function GroupMachines(props: ViewProps) {
  const { source, page, chat } = props;
  const machines = useTexMachines(source, chat, page.changes);
  const { read } = useTexList(source, chat, "settings", page.changes);
  const mine = machines?.kind === "ok" ? machines.value.machines.filter((m) => m.state !== "pending") : [];
  if (mine.length === 0) return null;
  // The chat's people by handle when the gateway names them; a rule keeps ids, and only a handle reads back to one.
  const people = machines?.kind === "ok" && machines.value.chatPeople ? machines.value.chatPeople : ((read?.kind === "ok" ? read.value.people : undefined) ?? []).filter((p) => p !== "You");

  return (
    <View style={{ gap: 8 }} testID="tex-group-machines">
      <SectionHead>Machines</SectionHead>
      <ListBox>
        {mine.map((m) => (
          <MachineBlock key={m.id} m={m} chat={chat} page={page} people={people} indent={NEST_INDENT} />
        ))}
      </ListBox>
    </View>
  );
}

/** One machine's header, and beneath it its settings for this chat (or the add button when it is not in the chat). */
function MachineBlock({
  m,
  chat,
  page,
  people,
  indent,
}: {
  m: Machine;
  chat: string;
  page: ViewProps["page"];
  people: string[];
  indent: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const base = `tex-group-machine-${m.id}`;
  const c = m.chats.find((x) => x.key === chat);
  const glyph: MachineGlyph = m.kind === "mac" ? "laptop" : "terminal";
  const sub = `Yours · ${stateWord(m.state)}${c ? ` · ${m.running.length} of ${m.slots} busy` : " · not in this chat"}`;

  return (
    <>
      <View style={styles.row} testID={base}>
        <GlyphSquare glyph={glyph} />
        <View style={styles.body}>
          <T size={14} weight="500">
            {m.name}
          </T>
          <DotLine tone={dotOf(m.state)} size={13}>
            {sub}
          </DotLine>
        </View>
        {c ? null : (
          <Button label="Add to this chat" look="outline" onPress={() => void page.act({ type: "machine.chat.add", id: m.id, chat })} testID={`${base}-add`} />
        )}
      </View>
      {c ? <ChatSettings m={m} c={c} base={base} chat={chat} page={page} people={people} indent={indent} /> : null}
    </>
  );
}

/** The settings for one machine in one chat, and the fixed line about what others may use. */
function ChatSettings({
  m,
  c,
  base,
  chat,
  page,
  people,
  indent,
}: {
  m: Machine;
  c: MachineChat;
  base: string;
  chat: string;
  page: ViewProps["page"];
  people: string[];
  indent: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const save = (values: { who?: MachineWho; askFirst?: boolean; slots?: number }) => void page.act({ type: "machine.chat", id: m.id, chat, values });
  const whoOptions: SelectOption[] = [
    { key: "me", label: "Only you" },
    { key: "everyone", label: "Everyone here" },
    ...people.map((p) => ({ key: `${PERSON}${p}`, label: p })),
  ];
  const key = c.who === "me" || c.who === "everyone" ? c.who : Array.isArray(c.who) && c.who.length === 1 ? `${PERSON}${c.who[0]}` : "";
  const selected = whoOptions.some((o) => o.key === key) ? key : whoLabel(c.who);
  const lockFor = m.kind === "cli" ? "this computer's" : "this Mac's";

  return (
    <>
      <View style={[styles.nested, { paddingLeft: indent }]} testID={`${base}-who-row`}>
        <View style={styles.body}>
          <T size={14} weight="500">
            Who can send it work
          </T>
          <T size={13} tone="muted">
            Besides you
          </T>
        </View>
        <View style={{ alignSelf: "center" }}>
          <TexSelect
            look="sel"
            label="Who can send it work"
            options={whoOptions}
            selected={selected}
            onPick={(pick) => save({ who: pick === "me" || pick === "everyone" ? pick : [pick.slice(PERSON.length)] })}
            testID={`${base}-who`}
          />
        </View>
      </View>
      {c.who !== "me" ? (
        <View style={[styles.nested, { paddingLeft: indent }]} testID={`${base}-ask-row`}>
          <View style={styles.body}>
            <T size={14} weight="500">
              Ask me first
            </T>
            <T size={13} tone="muted">
              When someone else sends it work
            </T>
          </View>
          <Switch label="Ask me first" value={c.askFirst} onValueChange={(askFirst) => save({ askFirst })} style={{ alignSelf: "center" }} testID={`${base}-ask`} />
        </View>
      ) : null}
      <View style={[styles.nested, { paddingLeft: indent }]} testID={`${base}-slots-row`}>
        <View style={styles.body}>
          <T size={14} weight="500">
            Slots for this chat
          </T>
          <T size={13} tone="muted">
            {`Of the ${m.slots} on ${hereOf(m)}`}
          </T>
        </View>
        <Stepper value={c.slots} min={1} max={m.slots} label="slots for this chat" onChange={(slots) => save({ slots })} testID={`${base}-slots`} />
      </View>
      <View style={[styles.note, { paddingLeft: indent }]} testID={`${base}-lock-row`}>
        <View style={styles.lock}>
          <View style={{ marginTop: 3 }}>
            <Glyph glyph="lock" color={colors.muted} size={14} />
          </View>
          <T size={13} tone="muted" style={{ flexShrink: 1 }} testID={`${base}-lock`}>
            {`Others' jobs stay in ${lockFor} chosen folders. Computer use is only for your own asks.`}
          </T>
        </View>
        <RowLink label="Remove from this chat" tone="crit" onPress={() => void page.act({ type: "machine.chat.remove", id: m.id, chat })} testID={`${base}-remove`} />
      </View>
    </>
  );
}

/** The state's word in the header line: `Online`, `Offline`, `Paused`, `Not ready`. */
function stateWord(state: MachineState): string {
  if (state === "online") return "Online";
  if (state === "offline") return "Offline";
  if (state === "paused") return "Paused";
  return "Not ready";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      gap: 12,
      alignItems: "center",
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    nested: {
      flexDirection: "row",
      gap: 12,
      alignItems: "center",
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    note: {
      gap: 8,
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    lock: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
    body: { flex: 1, minWidth: 0 },
  });
