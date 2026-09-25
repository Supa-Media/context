import { Fragment, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../../design/components/Text";
import { useCopy } from "../../design/useCopy";
import { notePlace, noteTitle, type WrittenNote } from "../checks";
import { BRING_TOPICS, type BringTopic } from "../bring";
import { useGuideStyles } from "./styles";

/**
 * The guide's small parts: one heading, prose with bold words and menu paths
 * in it, a box to copy from, the checks that tick themselves, and the notes an
 * agent wrote. Each is drawn from `styles.ts` so the two densities never drift.
 */

export function Heading({ children }: { children: string }) {
  const s = useGuideStyles();
  return (
    <Text role="heading" aria-level={1} style={s.h1}>
      {children}
    </Text>
  );
}

export function P({ children, small = false }: { children: ReactNode; small?: boolean }) {
  const s = useGuideStyles();
  return <Text style={small ? [s.small, { marginBottom: 12 }] : s.p}>{children}</Text>;
}

export function B({ children }: { children: ReactNode }) {
  const s = useGuideStyles();
  return <Text style={s.b}>{children}</Text>;
}

/** `Settings › General`, the way a menu path reads: bold words, quiet arrows. */
export function MenuPath({ parts }: { parts: readonly string[] }) {
  const s = useGuideStyles();
  return (
    <Text style={s.b}>
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? <Text style={s.sep}> › </Text> : null}
          {part}
        </Fragment>
      ))}
    </Text>
  );
}

export function Link({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const s = useGuideStyles();
  return (
    <Text role="link" onPress={onPress} style={s.link} testID={testID}>
      {label}
    </Text>
  );
}

function CopyChip({ value, label, testID }: { value: string; label: string; testID?: string }) {
  const s = useGuideStyles();
  const copy = useCopy(value);
  const done = copy.label !== "Copy";
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={copy.copy}
      style={[s.chip, done && s.chipDone]}
      testID={testID}
    >
      <Text style={[s.chipLabel, done && s.chipLabelDone]}>{copy.label}</Text>
    </Pressable>
  );
}

/** A labelled value with its own Copy, for a form in the other app. */
export function CopyRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const s = useGuideStyles();
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={s.copy}>
        <Text style={s.copyValue} numberOfLines={1} selectable>
          {value}
        </Text>
        <CopyChip value={value} label={`Copy ${label}`} testID={testID} />
      </View>
    </View>
  );
}

/** A paragraph to paste somewhere, with a note under it and its Copy. */
export function PromptBox({
  text,
  note,
  copyLabel,
  testID,
}: {
  text: string;
  note?: string;
  copyLabel: string;
  testID?: string;
}) {
  const s = useGuideStyles();
  return (
    <View style={s.prompt}>
      <Text style={s.promptText} selectable>
        {text}
      </Text>
      <View style={s.promptFoot}>
        <Text style={[s.small, { flex: 1 }]}>{note ?? ""}</Text>
        <CopyChip value={text} label={copyLabel} testID={testID} />
      </View>
    </View>
  );
}

export type CheckTone = "ok" | "wait" | "todo" | "warn" | "bad";

export interface CheckItem {
  tone: CheckTone;
  title: string;
  sub?: string;
}

const GLYPH: Record<CheckTone, string> = { ok: "✓", wait: "", todo: "", warn: "!", bad: "✕" };

/** What the guide has seen for itself. Announced as it changes. */
export function Checks({ items, testID }: { items: readonly CheckItem[]; testID?: string }) {
  const s = useGuideStyles();
  const toneStyle = { ok: s.dotOk, wait: s.dotWait, todo: s.dotTodo, warn: s.dotWarn, bad: s.dotBad };
  const glyphColor = { ok: s.glyphOk, wait: null, todo: null, warn: s.glyphWarn, bad: s.glyphBad };
  return (
    <View style={s.checks} role="status" aria-live="polite" testID={testID}>
      {items.map((item, index) => (
        <View key={item.title} style={[s.ck, index > 0 && s.ckRule]} testID={testID ? `${testID}-${item.tone}` : undefined}>
          <View style={[s.dot, toneStyle[item.tone]]} aria-hidden>
            {item.tone === "wait" ? (
              <View style={s.dotWaitInner} />
            ) : (
              <Text style={[s.dotGlyph, glyphColor[item.tone]]}>{GLYPH[item.tone]}</Text>
            )}
          </View>
          <View style={s.ckText}>
            <Text style={s.ckTitle}>{item.title}</Text>
            {item.sub === undefined ? null : <Text style={s.ckSub}>{item.sub}</Text>}
          </View>
        </View>
      ))}
    </View>
  );
}

/** The notes an agent wrote, newest last; each opens the note. */
export function WrittenList({
  notes,
  onOpen,
  testID,
}: {
  notes: readonly WrittenNote[];
  onOpen?: (path: string) => void;
  testID?: string;
}) {
  const s = useGuideStyles();
  return (
    <View style={s.written} testID={testID}>
      {notes.map((note, index) => (
        <Pressable
          key={note.path}
          role={onOpen ? "link" : undefined}
          accessibilityLabel={onOpen ? `Open ${noteTitle(note.path)}` : undefined}
          disabled={onOpen === undefined}
          onPress={() => onOpen?.(note.path)}
          style={[s.wr, index > 0 && s.ckRule]}
        >
          <Text style={s.wrTitle} numberOfLines={1}>
            {noteTitle(note.path)}
          </Text>
          <Text style={s.wrPath} numberOfLines={1}>
            {notePlace(note.path)}
            {onOpen ? " ›" : ""}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** "Still stuck?" and what to try, in order. */
export function Tips({ items }: { items: readonly ReactNode[] }) {
  const s = useGuideStyles();
  return (
    <View>
      <Text style={s.tipsHead}>Still stuck?</Text>
      {items.map((item, index) => (
        <View key={index} style={s.tip}>
          <Text style={s.tipText}>{index + 1}.</Text>
          <Text style={s.tipText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/** The four things to bring over, as checkboxes. */
export function TopicPicker({
  topics,
  onToggle,
}: {
  topics: readonly BringTopic[];
  onToggle: (topic: BringTopic) => void;
}) {
  const s = useGuideStyles();
  return (
    <View>
      {BRING_TOPICS.map((row, index) => {
        const on = topics.includes(row.key);
        return (
          <Pressable
            key={row.key}
            role="checkbox"
            aria-checked={on}
            accessibilityLabel={`${row.label}. ${row.sub}`}
            onPress={() => onToggle(row.key)}
            style={[s.opt, index > 0 && s.ckRule]}
            testID={`agent-setup-topic-${row.key}`}
          >
            <View style={[s.box, on && s.boxOn]} aria-hidden>
              {on ? <Text style={s.boxMark}>✓</Text> : null}
            </View>
            <View style={s.ckText}>
              <Text style={s.optTitle}>{row.label}</Text>
              <Text style={s.optSub}>{row.sub}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A quiet "See the prompt" / "Show me where" that opens what it names. */
export function Reveal({ label, children, testID }: { label: string; children: ReactNode; testID?: string }) {
  const s = useGuideStyles();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        role="button"
        aria-expanded={open}
        onPress={() => setOpen((value) => !value)}
        style={s.toggle}
        testID={testID}
      >
        <Text style={s.toggleLabel}>{label}</Text>
      </Pressable>
      {open ? <View style={{ marginTop: 8 }}>{children}</View> : null}
    </View>
  );
}

export function Gap() {
  const s = useGuideStyles();
  return <View style={s.gap} />;
}
