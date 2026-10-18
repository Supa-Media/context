/**
 * The AI tab's skills (board 14, "add one, and choose which AIs get it"): one
 * row per skill under `ai/production/skills/`, with three switches for who
 * reads it. Tex's switch edits the live texting setup's `skills:` list, the one
 * place the gateway reads it from; the other two edit the skill's own `reach:`
 * line. The selected skill is edited in place beside the table
 * (`AiNoteEditor`). A switch waits for its write, and nothing here publishes a
 * skill: it only says which AIs read it.
 */

import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { Switch } from "../design/components/Switch";
import { Box, Cell, Columns, Head, OneWay, PageHead, Primary, Quiet, Quietly, TableLine, shortDay, type Column } from "./AiKit";
import { matches, provedBy, type AiNoteRow } from "./aiCatalog";
import { compact, setupSkills, skillReach, tokensOf, withReach, withSkill, type ReachKey } from "./aiModel";
import type { AiScreenProps } from "./aiScreen";
import { AiNoteEditor, slugFor, starterFor } from "./AiNoteEditor";
import { messageOf, useNoteText, useNoteWriter } from "./useAiNote";

const SKILLS_FOLDER = "ai/production/skills";
const TEXTING_JOB = "texting-assistant";

const COLUMNS: readonly Column[] = [
  { label: "SKILL", flex: 2 },
  { label: "SIZE", width: 60, align: "right" },
  { label: "TEX", width: 70 },
  { label: "EVERY AI", width: 80 },
  { label: "HELPERS", width: 80 },
  { label: "PROVED BY", width: 110 },
];

/** Beside an open skill: its panel shows the size and the cases, so the table keeps the name and the switches. */
const NARROW_COLUMNS: readonly Column[] = COLUMNS.filter((column) => column.label !== "SIZE" && column.label !== "PROVED BY");

const SIZE_NOTE =
  "Size is in tokens. Tex reads a skill only when a text needs it, so its size counts when it's read, not on every text. Skills a person's Tex wrote stay in their own workspace.";
const REACH_NOTE = "Every connected AI and helper agents read this from the skill's reach: line once the new tools are live.";

/** Which switch is being written, so the others wait. */
type Busy = "tex" | "mcp" | "helpers" | "new";

/** A skill's size for its SIZE cell: `—` when the tree did not list its bytes. */
const sizeOf = (row: AiNoteRow): string => (row.size === null ? "—" : compact(tokensOf(row.size)));

/** Turns a skill's `reach:` switches on or off, and Tex's on the live setup. */
export function AiSkills(props: AiScreenProps & { skill: string | null }) {
  const { catalog, go, reload, openInNotes, workspaceId, skill } = props;
  const styles = useThemedStyles(makeStyles);
  const write = useNoteWriter(workspaceId);
  const texRow = catalog.jobs.find((job) => job.job.key === TEXTING_JOB)?.setup ?? null;
  const liveTex = useNoteText(workspaceId, texRow?.path ?? null);
  // The tree is not re-read for one note's text, so a Tex write is kept here until the next visit.
  const [texEdit, setTexEdit] = useState<{ path: string; text: string } | null>(null);
  const texText = texEdit !== null && texEdit.path === texRow?.path ? texEdit.text : liveTex;
  const texSkills = texText ? setupSkills(texText) : [];

  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<Busy | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setConfirmOff(false);
    setProblem(null);
  }, [skill]);

  const skills = catalog.skills;
  const shown = skills.filter((row) => matches(row, query));
  const selected = skill === null ? null : (skills.find((row) => row.name === skill) ?? null);

  /** Runs one write, then re-reads the folder; a failure is shown inline, never thrown. */
  async function run(key: Busy, job: () => Promise<void>) {
    setProblem(null);
    setBusy(key);
    try {
      await job();
      reload();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(null);
    }
  }

  function setTex(row: AiNoteRow, on: boolean) {
    if (texRow === null) return;
    const path = texRow.path;
    const captured = { text: null as string | null };
    void run("tex", async () => {
      await write(path, (text) => {
        const next = withSkill(text ?? "", row.name, on, row.lede || row.title);
        captured.text = next;
        return next;
      });
      if (captured.text !== null) setTexEdit({ path, text: captured.text });
    });
  }

  function setReach(row: AiNoteRow, key: "mcp" | "helpers", on: boolean) {
    void run(key, () => write(row.path, (text) => withReach(text ?? "", key, on)));
  }

  /** Turning Tex off waits for a yes: the next text stops reading the skill. */
  function onTex(row: AiNoteRow, on: boolean) {
    if (on) setTex(row, true);
    else setConfirmOff(true);
  }

  function createSkill() {
    const title = newName.trim();
    const slug = slugFor(title).replace(/^-+/, "");
    if (slug === "") {
      setProblem("Give it a name first.");
      return;
    }
    const path = `${SKILLS_FOLDER}/${slug}.md`;
    if (skills.some((row) => row.path === path)) {
      setProblem(`A skill named ${slug} is already there.`);
      return;
    }
    void run("new", async () => {
      await write(path, (text) => text ?? starterFor(SKILLS_FOLDER, title));
      setCreating(false);
      setNewName("");
      go({ view: "skills", skill: slug });
    });
  }

  const actions = (
    <View style={styles.actions}>
      <TextField
        label="Search skills"
        labelHidden
        placeholder="Search skills…"
        value={query}
        onChangeText={setQuery}
        containerStyle={styles.find}
        testID="admin-ai-skill-find"
      />
      <Primary label="New skill" onPress={() => setCreating(true)} disabled={busy !== null} testID="admin-ai-skill-new" />
    </View>
  );

  const creatingRow = creating ? (
    <View style={styles.creating} testID="admin-ai-skill-creating">
      <TextField
        label="What it's for, in a few words"
        labelHidden
        placeholder="What it's for, in a few words"
        value={newName}
        onChangeText={setNewName}
        containerStyle={styles.newField}
        testID="admin-ai-skill-new-name"
      />
      <Primary label="Create skill" onPress={createSkill} disabled={newName.trim() === "" || busy !== null} testID="admin-ai-skill-new-create" />
      <Quiet
        label="Cancel"
        onPress={() => {
          setCreating(false);
          setNewName("");
          setProblem(null);
        }}
        testID="admin-ai-skill-new-cancel"
      />
    </View>
  ) : null;

  const table = (
    <View style={styles.list}>
      <Head columns={selected === null ? COLUMNS : NARROW_COLUMNS} />
      {shown.map((row, index) => (
        <SkillLine
          key={row.path}
          narrow={selected !== null}
          row={row}
          reach={skillReach(row, texSkills)}
          proved={provedBy(row, catalog.tests)}
          texLocked={texRow === null}
          busy={busy !== null}
          selected={selected?.path === row.path}
          first={index === 0}
          last={index === shown.length - 1}
          onPress={() => go({ view: "skills", skill: row.name })}
          onTex={(on) => onTex(row, on)}
          onReach={(key, on) => setReach(row, key, on)}
        />
      ))}
      {skills.length === 0 ? <Quietly testID="admin-ai-skill-empty">No skills yet. New skill makes one.</Quietly> : null}
      <Quietly testID="admin-ai-skill-note">{SIZE_NOTE}</Quietly>
    </View>
  );

  // With no skill open the table has the page's whole width; one opens beside it.
  const panel =
    selected === null ? null : (
      <SkillPanel
        row={selected}
        reach={skillReach(selected, texSkills)}
        proved={provedBy(selected, catalog.tests)}
        texLocked={texRow === null}
        busy={busy !== null}
        confirmOff={confirmOff}
        onTex={(on) => onTex(selected, on)}
        onTexOff={() => {
          setConfirmOff(false);
          setTex(selected, false);
        }}
        onKeep={() => setConfirmOff(false)}
        onReach={(key, on) => setReach(selected, key, on)}
        onCase={() => go({ view: "jobs", job: TEXTING_JOB, tab: "cases", compare: null })}
        editor={
          <AiNoteEditor
            key={selected.path}
            workspaceId={workspaceId}
            path={selected.path}
            folder={SKILLS_FOLDER}
            crumb="skills"
            row={selected}
            tests={catalog.tests}
            onClose={(saved) => {
              if (saved) reload();
              go({ view: "skills", skill: null });
            }}
            onOpenInNotes={openInNotes}
          />
        }
      />
    );

  return (
    <View style={styles.wrap} testID="admin-ai-skills">
      <PageHead title="Skills" sub={`${skills.length} · managed`} actions={actions} testID="admin-ai-skills-head" />
      {creatingRow}
      {problem !== null ? <OneWay testID="admin-ai-skill-problem">{problem}</OneWay> : null}
      {panel === null ? (
        table
      ) : (
        <Columns weights={[1, 1]}>
          {table}
          {panel}
        </Columns>
      )}
    </View>
  );
}

/** One skill's row: the table line on a pointer, a two-line row on a phone. */
function SkillLine({
  row,
  reach,
  proved,
  texLocked,
  busy,
  selected,
  first,
  last,
  onPress,
  onTex,
  onReach,
  narrow,
}: {
  row: AiNoteRow;
  reach: Record<ReachKey, boolean>;
  proved: readonly AiNoteRow[];
  texLocked: boolean;
  busy: boolean;
  selected: boolean;
  first: boolean;
  last: boolean;
  onPress: () => void;
  onTex: (on: boolean) => void;
  onReach: (key: "mcp" | "helpers", on: boolean) => void;
  narrow: boolean;
}) {
  const switches = [
    <Switch key="tex" value={reach.tex} onValueChange={onTex} label="Tex" disabled={busy || texLocked} testID={`admin-ai-skill-${row.name}-tex`} />,
    <Switch
      key="mcp"
      value={reach.mcp}
      onValueChange={(on) => onReach("mcp", on)}
      label="Every connected AI"
      disabled={busy}
      testID={`admin-ai-skill-${row.name}-mcp`}
    />,
    <Switch
      key="helpers"
      value={reach.helpers}
      onValueChange={(on) => onReach("helpers", on)}
      label="Helper agents"
      disabled={busy}
      testID={`admin-ai-skill-${row.name}-helpers`}
    />,
  ];
  const skill = <Cell key="skill" title={row.title} sub={row.lede} strong />;
  return (
    <TableLine
      columns={narrow ? NARROW_COLUMNS : COLUMNS}
      cells={
        narrow
          ? [skill, ...switches]
          : [
              skill,
              <Cell key="size" title={sizeOf(row)} align="right" />,
              ...switches,
              proved.length > 0 ? (
                <Cell key="proved" title={proved.map((test) => test.name).join(", ")} tone="ok" />
              ) : (
                <Cell key="proved" title="no case" tone="crit" />
              ),
            ]
      }
      title={row.title}
      sub={row.lede}
      first={first}
      last={last}
      selected={selected}
      onPress={onPress}
      testID={`admin-ai-skill-row-${row.name}`}
    />
  );
}

/** The selected skill's panel: its three switches, the Tex confirmation, the note in place, and its footer. */
function SkillPanel({
  row,
  reach,
  proved,
  texLocked,
  busy,
  confirmOff,
  onTex,
  onTexOff,
  onKeep,
  onReach,
  onCase,
  editor,
}: {
  row: AiNoteRow;
  reach: Record<ReachKey, boolean>;
  proved: readonly AiNoteRow[];
  texLocked: boolean;
  busy: boolean;
  confirmOff: boolean;
  onTex: (on: boolean) => void;
  onTexOff: () => void;
  onKeep: () => void;
  onReach: (key: "mcp" | "helpers", on: boolean) => void;
  onCase: () => void;
  editor: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const reading = [reach.tex ? "Tex, by text" : null, reach.mcp ? "connected AIs" : null, reach.helpers ? "helper agents" : null].filter(
    (item): item is string => item !== null,
  );
  const size = sizeOf(row);
  const footer = `Read by ${reading.length > 0 ? reading.join(", ") : "nobody"} · Proved by ${
    proved.length > 0 ? proved.map((test) => test.name).join(", ") : "no case"
  } · ${size === "—" ? "size unknown" : `${size} tokens`} · changed ${shortDay(row.updatedAt)}`;

  return (
    <Box title={row.title} right={<Text variant="meta" numberOfLines={1}>{row.path}</Text>} testID="admin-ai-skill-panel">
      <View style={styles.toggles}>
        <Toggle label="Tex" value={reach.tex} disabled={busy || texLocked} onValueChange={onTex} testID="admin-ai-skill-open-tex" />
        <Toggle label="Every connected AI" value={reach.mcp} disabled={busy} onValueChange={(on) => onReach("mcp", on)} testID="admin-ai-skill-open-mcp" />
        <Toggle label="Helper agents" value={reach.helpers} disabled={busy} onValueChange={(on) => onReach("helpers", on)} testID="admin-ai-skill-open-helpers" />
      </View>
      <Text variant="meta" testID="admin-ai-skill-reach-note">{REACH_NOTE}</Text>
      {confirmOff ? (
        <View style={styles.confirm} testID="admin-ai-skill-confirm">
          <OneWay testID="admin-ai-skill-warning">{`Tex stops reading ${row.title} from the next text.`}</OneWay>
          <View style={styles.buttons}>
            <Quiet label="Turn off" tone="crit" disabled={busy} onPress={onTexOff} testID="admin-ai-skill-tex-off" />
            <Quiet label="Keep" onPress={onKeep} testID="admin-ai-skill-tex-keep" />
          </View>
        </View>
      ) : null}
      {editor}
      <View style={styles.footer}>
        <Text variant="meta" numberOfLines={2} style={styles.footText} testID="admin-ai-skill-footer">
          {footer}
        </Text>
        <Quiet label="Add a case" onPress={onCase} testID="admin-ai-skill-case" />
      </View>
    </Box>
  );
}

/** A switch with its name beside it, for the panel's row of three. */
function Toggle({ label, value, disabled, onValueChange, testID }: { label: string; value: boolean; disabled: boolean; onValueChange: (on: boolean) => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.toggle}>
      <Switch value={value} onValueChange={onValueChange} label={label} disabled={disabled} testID={testID} />
      <Text variant="meta" numberOfLines={1}>{label}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x4, minWidth: 0 },
    actions: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    find: { minWidth: 200 },
    creating: { flexDirection: "row", alignItems: "center", gap: space.x2, flexWrap: "wrap" },
    newField: { flexGrow: 1, minWidth: 240 },
    list: { minWidth: 0 },
    toggles: { flexDirection: "row", flexWrap: "wrap", gap: space.x4 },
    toggle: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    confirm: { gap: space.x2, paddingTop: space.x3, borderTopWidth: 1, borderTopColor: colors.line },
    footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.x3 },
    footText: { flexShrink: 1, minWidth: 0 },
  });
