/**
 * The case form in the middle of board 13's Golden cases tab: what the person
 * texts, who is asking, what their notes say, a good reply as rules the judge
 * and the run's record check, and the example. Each field edits one line of
 * the note through the callbacks `./AiCases` hands it, so every other line of
 * the file stays as written. A drafted case says so until a person checks it.
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Pill, Text, space, useThemedStyles, type Colors, type PillTone } from "../design";
import { pointerType } from "../design/tokens";
import { useFieldFont } from "../design/fieldFont";
import { LinkText, Quiet } from "./AiKit";
import { DRAFTED_KEY } from "./aiModel";
import { ruleLabel, ruleTone, type CaseLine, type RuleTone, type TestCase } from "./testList";

/** The rules "+ Add a rule" offers. Any other line can still be typed in Markdown. */
export const NEW_RULES = ["must", "must not", "may", "judge", "must call", "must write"] as const;

/** The reply that stands for what the person texts first, when a case has one. */
const PERSON_STARTS = "person starts";

export function CaseForm({ item, runAs, path, onTitle, onLine, onRemove, onAdd }: {
  item: TestCase;
  /** The list's `run_as:` front matter, shown when the case names no `as:` line of its own. */
  runAs: string | null;
  /** The note the case is saved in, named in the footer. */
  path: string;
  onTitle: (value: string) => void;
  onLine: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: (key: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const [adding, setAdding] = useState(false);
  const starts = item.replies.find((line) => line.key === PERSON_STARTS) ?? null;
  const asked = item.replies.filter((line) => line.key !== PERSON_STARTS);
  const example = item.other.find((line) => line.key === "example") ?? null;
  const drafted = item.other.find((line) => line.key === DRAFTED_KEY) ?? null;
  // Held as typed: the note reads a heading with its trailing space trimmed.
  const [text, setText] = useState(starts?.value ?? item.title);

  return (
    <View style={styles.form} testID="admin-ai-case-form">
      <Text variant="eyebrow">WHEN THEY TEXT</Text>
      <TextInput
        value={text}
        onChangeText={(value) => {
          setText(value);
          if (starts) onLine(starts.index, value);
          else onTitle(value);
        }}
        style={[styles.title, fieldFont]}
        accessibilityLabel="When they text"
        testID="admin-ai-case-title"
      />

      <Text variant="eyebrow" style={styles.section}>WHO IS ASKING</Text>
      {item.person ? (
        <RuleRow line={item.person} label="as" onLine={onLine} />
      ) : (
        <Text variant="body" numberOfLines={1}>{runAs ?? "Nobody named yet"}</Text>
      )}

      <Text variant="eyebrow" style={styles.section}>THEIR NOTES SAY</Text>
      <Text variant="meta" numberOfLines={3} style={styles.notes}>{item.description || "Nothing noted."}</Text>

      <Text variant="eyebrow" style={styles.section}>A GOOD REPLY</Text>
      {item.rules.map((line) => (
        <RuleRow key={line.index} line={line} tone={ruleTone(line.key)} label={ruleLabel(line.key)} onLine={onLine} onRemove={onRemove} />
      ))}
      {asked.map((line) => (
        <RuleRow key={line.index} line={line} label={line.key} onLine={onLine} onRemove={onRemove} />
      ))}
      {adding ? (
        <View style={styles.chooser}>
          {NEW_RULES.map((key) => (
            <Pressable key={key} role="button" onPress={() => { onAdd(key); setAdding(false); }} testID={`admin-ai-add-rule-${key.replace(/ /g, "-")}`}>
              <Pill tone={toneTone(ruleTone(key))}>{key}</Pill>
            </Pressable>
          ))}
        </View>
      ) : (
        <LinkText label="+ Add a rule" onPress={() => setAdding(true)} testID="admin-ai-add-rule" />
      )}

      <Text variant="eyebrow" style={styles.section}>EXAMPLE OF A GOOD REPLY (optional, shown to the judge)</Text>
      {example ? (
        <ExampleField line={example} onLine={onLine} />
      ) : (
        <LinkText label="+ Add an example" onPress={() => onAdd("example")} testID="admin-ai-add-example" />
      )}

      {drafted ? (
        <View style={styles.drafted} testID="admin-ai-drafted">
          <Text variant="meta" style={styles.muted}>{`Drafted by ${drafted.value}. It does not count until a person checks it.`}</Text>
          <Quiet label="Mark as checked" onPress={() => onRemove(drafted.index)} testID="admin-ai-case-mark-checked" />
        </View>
      ) : null}

      <Text variant="meta" style={styles.muted}>{`Edits save to ${path}. Claude and other AIs edit the same note.`}</Text>
    </View>
  );
}

/** A rule's tone as a pill's: must is ok, must not is crit, the rest neutral. */
function toneTone(tone: RuleTone): PillTone {
  if (tone === "must") return "ok";
  if (tone === "mustNot") return "crit";
  return "neutral";
}

/**
 * One `- key: value` line as a row: its label (a Pill for a rule), then the
 * value, which grows with what is typed so a long rule reads whole. A `×`
 * removes the line when `onRemove` is given.
 */
function RuleRow({ line, label, tone, onLine, onRemove }: {
  line: CaseLine;
  label: string;
  tone?: RuleTone;
  onLine: (index: number, value: string) => void;
  onRemove?: (index: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.row} testID={`admin-ai-line-${line.index}`}>
      {tone ? (
        <View style={styles.pillSlot}>
          <Pill tone={toneTone(tone)}>{label}</Pill>
        </View>
      ) : (
        <View style={styles.chip}>
          <Text variant="mini" style={styles.muted} numberOfLines={1}>{label}</Text>
        </View>
      )}
      <AutoValue line={line} label={label} onLine={onLine} />
      {onRemove ? (
        <Pressable role="button" accessibilityLabel={`Remove this ${label} line`} onPress={() => onRemove(line.index)} hitSlop={8} testID={`admin-ai-line-${line.index}-remove`}>
          <Text variant="meta" style={styles.muted}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** The `example:` line, which is a whole reply: a box that grows with it. */
function ExampleField({ line, onLine }: { line: CaseLine; onLine: (index: number, value: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.exampleBox}>
      <AutoValue line={line} label="example" onLine={onLine} multiline />
    </View>
  );
}

/** A field bound to one bullet's value; it keeps what is typed and grows with it. */
function AutoValue({ line, label, onLine, multiline = false }: {
  line: CaseLine;
  label: string;
  onLine: (index: number, value: string) => void;
  multiline?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const [value, setValue] = useState(line.value);
  const [height, setHeight] = useState<number | null>(null);
  return (
    <TextInput
      multiline
      numberOfLines={1}
      value={value}
      onChangeText={(next) => {
        setValue(next);
        onLine(line.index, next);
      }}
      onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)}
      style={[styles.input, multiline && styles.inputBlock, fieldFont, height !== null && { height: Math.max(32, height) }]}
      accessibilityLabel={label}
      testID={`admin-ai-line-${line.index}-value`}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    form: { flex: 1, minWidth: 0, gap: space.x2 },
    title: { color: colors.text, fontSize: pointerType.lede, fontWeight: "600", borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x3, paddingVertical: space.x2, backgroundColor: colors.ground, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null) },
    section: { marginTop: space.x3 },
    muted: { color: colors.muted },
    notes: { color: colors.muted },
    row: { flexDirection: "row", alignItems: "center", gap: space.x2, borderBottomWidth: 1, borderBottomColor: colors.line, paddingVertical: 4, minWidth: 0 },
    pillSlot: { flexShrink: 0 },
    chip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 200, backgroundColor: colors.chipFill, flexShrink: 0 },
    input: { flex: 1, minWidth: 0, color: colors.text, fontSize: pointerType.ui, paddingVertical: 6, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null) },
    inputBlock: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x3, backgroundColor: colors.ground },
    exampleBox: { minWidth: 0 },
    chooser: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    drafted: { gap: space.x2, alignItems: "flex-start", marginTop: space.x3 },
  });
