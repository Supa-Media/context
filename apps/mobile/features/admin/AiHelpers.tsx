/**
 * The AI tab's helper agents (board 15, "the AIs other AIs call"): one row per
 * helper with who calls it, what it can do, what it never does without a
 * person, and its tools. Under the table, the selected helper's own note and
 * who may call it. Turning a caller on writes the note's `callers:` after a
 * yes, because that lets the caller ask for email to be sent. Nothing here
 * sends anything.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { Switch } from "../design/components/Switch";
import { Box, Cell, Columns, Head, OneWay, PageHead, Quiet, Quietly, StatStrip, TableLine, type Column } from "./AiKit";
import type { AiNoteRow } from "./aiCatalog";
import { AI_HELPERS, HELPERS_FOLDER, callerLabel, helperCallers, sizeLabel, withFrontKey, type AiHelper } from "./aiModel";
import type { AiScreenProps } from "./aiScreen";
import { useNoteWriter } from "./useAiNote";

const DEFAULT_HELPER = "mail-checker";

const COLUMNS: readonly Column[] = [
  { label: "HELPER AGENT", flex: 1.2 },
  { label: "CALLED BY", flex: 1 },
  { label: "CAN DO", flex: 1.4 },
  { label: "NEEDS A PERSON FOR", flex: 1 },
  { label: "STATE", width: 110 },
  { label: "TOOLS", flex: 1.6 },
];

/** What each helper does, as its panel says it. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  "mail-checker":
    "Checks a draft before it leaves: refuses one that names someone not in the person's contacts, promises money, or attaches a note marked private. Sends only after the person's yes reaches the gateway; if anything fails, nothing is sent. It needs an email action on the send tool, which the six tools do not have yet; it is built with that action.",
  improver:
    "Reads where live missed, drafts one change at a time as a new setup with based_on and change, drafts golden cases marked drafted, and runs the tests. It never promotes and never makes a case count: both wait for a person.",
  judge: "Scores each reply against a case's must, must not and judge lines for the test bench. It changes nothing.",
  dream: "Rewrites Tex's about-me each night from the day's texts and tidies the person's own skills, in their own workspace.",
};

export function AiHelpers(props: AiScreenProps & { helper: string | null }) {
  const { catalog, go, reload, openInNotes, workspaceId } = props;
  const styles = useThemedStyles(makeStyles);
  const writeNote = useNoteWriter(workspaceId);
  const [pending, setPending] = useState<string | null>(null);
  const selected = AI_HELPERS.find((item) => item.key === (props.helper ?? DEFAULT_HELPER)) ?? AI_HELPERS.find((item) => item.key === DEFAULT_HELPER) ?? AI_HELPERS[0];
  if (selected === undefined) return null;
  const path = `${HELPERS_FOLDER}/${selected.key}.md`;
  const note: AiNoteRow | null = catalog.other.find((row) => row.path === path) ?? null;
  const callers = helperCallers(note);
  const tools = selected.tools.length > 0 ? selected.tools.join(", ") : "none";

  const editNote = async () => {
    if (note !== null) {
      openInNotes(note.path);
      return;
    }
    await writeNote(path, (text) => text ?? starterNote(selected));
    reload();
  };

  const setCaller = async (key: string, on: boolean) => {
    const next = on ? [...callers, key] : callers.filter((item) => item !== key);
    await writeNote(path, (text) => withFrontKey(text ?? starterNote(selected), "callers", `[${next.join(", ")}]`));
    reload();
  };

  return (
    <View style={styles.wrap} testID="admin-ai-helpers">
      <PageHead title="Helper agents" sub="They come from code, like jobs." testID="admin-ai-helpers-head" />
      <View style={styles.table} testID="admin-ai-helpers-table">
        <Head columns={COLUMNS} />
        {AI_HELPERS.map((helper, index) => (
          <HelperLine
            key={helper.key}
            helper={helper}
            selected={helper.key === selected.key}
            first={index === 0}
            last={index === AI_HELPERS.length - 1}
            onPress={() => {
              setPending(null);
              go({ view: "helpers", helper: helper.key });
            }}
          />
        ))}
      </View>
      <Columns>
        <Box
          title={selected.label}
          right={<Text variant="meta" numberOfLines={1}>{path}</Text>}
          testID="admin-ai-helper-box"
        >
          <View style={styles.section}>
            <StatStrip
              stats={[
                { label: "PROMPT", value: sizeLabel(note?.size ?? null) ?? "no note yet" },
                { label: "TOOLS", value: String(selected.tools.length), sub: tools },
                { label: "STATE", value: selected.state === "running" ? "Running" : "Not built yet", tone: selected.state === "running" ? "ok" : "neutral" },
              ]}
              testID="admin-ai-helper-stats"
            />
            <Text variant="meta" testID="admin-ai-helper-about">{DESCRIPTIONS[selected.key] ?? ""}</Text>
            <View style={styles.buttons}>
              <Quiet label="Edit its note" onPress={() => void editNote()} testID="admin-ai-helper-edit" />
              {selected.key === "mail-checker" ? (
                <Quiet
                  label="Golden cases"
                  onPress={() => go({ view: "jobs", job: "texting-assistant", tab: "cases", compare: null })}
                  testID="admin-ai-helper-cases"
                />
              ) : null}
            </View>
          </View>
        </Box>
        <Box title="Who may call it" testID="admin-ai-callers">
          {selected.callers.length === 0 ? (
            <Quietly testID="admin-ai-callers-none">{`Nothing but ${selected.calledBy} calls it.`}</Quietly>
          ) : (
            <View style={styles.section}>
              {selected.callers.map((key) => (
                <View key={key} style={styles.switchRow}>
                  <Switch
                    value={callers.includes(key)}
                    onValueChange={(on) => {
                      if (on) setPending(key);
                      else void setCaller(key, false);
                    }}
                    label={callerLabel(key)}
                    testID={`admin-ai-caller-${key}`}
                  />
                  <Text variant="body" numberOfLines={1} style={styles.callerName}>{callerLabel(key)}</Text>
                </View>
              ))}
              {pending !== null ? (
                <View style={styles.confirm} testID="admin-ai-caller-confirm">
                  <OneWay testID="admin-ai-caller-warning">
                    {`${callerLabel(pending)} may then ask the ${selected.label} to send email. Every send still waits for the person's yes.`}
                  </OneWay>
                  <View style={styles.buttons}>
                    <Quiet
                      label="Allow"
                      tone="crit"
                      onPress={() => {
                        const key = pending;
                        setPending(null);
                        void setCaller(key, true);
                      }}
                      testID="admin-ai-caller-allow"
                    />
                    <Quiet label="Cancel" onPress={() => setPending(null)} testID="admin-ai-caller-cancel" />
                  </View>
                </View>
              ) : null}
              <View style={styles.rule}>
                <OneWay testID="admin-ai-callers-rule">An AI that isn't switched on here can't send email at all.</OneWay>
              </View>
            </View>
          )}
        </Box>
      </Columns>
    </View>
  );
}

/** The note a helper starts with when nobody has written one: its key, no callers yet, and its label and description. */
function starterNote(helper: AiHelper): string {
  return `---\nhelper: ${helper.key}\ncallers: []\n---\n\n# ${helper.label}\n\n${DESCRIPTIONS[helper.key] ?? ""}\n`;
}

/** One helper's row: the table line on a pointer, a two-line row on a phone. */
function HelperLine({ helper, selected, first, last, onPress }: { helper: AiHelper; selected: boolean; first: boolean; last: boolean; onPress: () => void }) {
  const nothing = helper.needsPerson === "nothing";
  const running = helper.state === "running";
  return (
    <TableLine
      columns={COLUMNS}
      cells={[
        <Cell key="agent" title={helper.label} sub={helper.model} strong />,
        <Cell key="called" title={helper.calledBy} />,
        <Cell key="does" title={helper.canDo} />,
        nothing ? <Cell key="person" title={helper.needsPerson} /> : <Cell key="person" title={helper.needsPerson} tone="crit" strong />,
        <Pill key="state" tone={running ? "ok" : "neutral"}>{running ? "Running" : "Not built yet"}</Pill>,
        <Cell key="tools" title={helper.tools.length > 0 ? helper.tools.join(", ") : "none"} />,
      ]}
      title={helper.label}
      sub={helper.model}
      first={first}
      last={last}
      selected={selected}
      onPress={onPress}
      testID={`admin-ai-helper-${helper.key}`}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x4, minWidth: 0 },
    table: { minWidth: 0 },
    section: { gap: space.x3, minWidth: 0 },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    switchRow: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x1, minWidth: 0 },
    callerName: { flexShrink: 1, minWidth: 0 },
    confirm: { gap: space.x2, paddingTop: space.x3, borderTopWidth: 1, borderTopColor: colors.line },
    rule: { paddingTop: space.x3, borderTopWidth: 1, borderTopColor: colors.line },
  });
