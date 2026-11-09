import { Fragment, useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { texPageType } from "../../design/tokens";
import { Ghost, Hint, ListBox, ListRow, More, pageStyles, SubPage, T, useNow } from "./TexPageParts";
import { day, isWhenField, whenField } from "./texPageFormat";
import type { ViewProps } from "./TexPageBody";
import { useTexList } from "./useTexPage";
import type { AboutLine, CheckIn, Routine, TexSwitches } from "./texPageTypes";

/**
 * The three pages a person edits from the Tex page: Routines, Check-ins and
 * About you (or About the group). Each one reads its list with `useTexList`,
 * writes with `page.act`, and applies its own change at once; a write that the
 * gateway refuses puts the row back and says so under the list.
 */

const ROUTINES_LEAD = "Things Tex does on a schedule. Switch one off or remove it here.";
const GROUP_ROUTINES_LEAD = "Things Tex does for this chat on a schedule. Anyone here can switch one off; text Tex in the chat to add or change one.";
const ROUTINES_HINT = "To add or change a routine, text Tex, like “every Monday at 9, plan my week”.";
const CHECKINS_LEAD = "When Tex looks in on you. Tap one to change or cancel it.";
const GROUP_CHECKINS_EMPTY = 'None set. Text Tex in the chat, like "check on us Sunday at 6".';
const CHANGE_HINT = `To change this, text Tex, like "don't check Slack".`;
/** Tex's own jobs, each with its switch (`switch.set`); Tex flips the same switch from a text. */
const SWITCH_ROWS = [
  { name: "housekeeping", title: "Tidy my notes", sub: "Once a day, with a way to undo each change" },
  { name: "dreams", title: "Update About me overnight", sub: "From what you texted that day" },
] as const;
const ABOUT_LEAD = "What Tex knows about you, the one copy it reads on every text. Tap a line to fix or remove it.";
const ABOUT_EMPTY = "Tex hasn't saved anything yet.";
const SAVE_FAILED = "Couldn't save that. Try again.";

/** Drops one key from a map, returning a new map. */
function without<V>(map: Record<string, V>, key: string): Record<string, V> {
  const next = { ...map };
  delete next[key];
  return next;
}

function SaveFailed() {
  return (
    <T size={13} tone="crit" testID="tex-save-failed">
      {SAVE_FAILED}
    </T>
  );
}

/* ---------------------------------------------------------------- Routines */

export function RoutinesPage({ source, page, chat, group }: ViewProps) {
  const styles = useThemedStyles(makeStyles);
  const { read } = useTexList(source, chat, "routines", page.changes);
  const [flips, setFlips] = useState<Record<string, boolean>>({});
  const [gone, setGone] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFlips({});
    setGone({});
  }, [read]);

  const title = group ? `Routines in ${group}` : "Routines";
  const lead = group ? GROUP_ROUTINES_LEAD : ROUTINES_LEAD;
  const data = read?.kind === "ok" ? read.value : null;
  if (data === null) return <SubPage title={title} lead={lead} testID="tex-routines" />;
  const items = data.items.filter((r) => !gone[r.id]);

  const toggle = async (r: Routine, on: boolean) => {
    setFailed(false);
    setFlips((f) => ({ ...f, [r.id]: on }));
    const answer = await page.act({ type: "routine.toggle", id: r.id, on });
    if (!answer.ok) {
      setFlips((f) => without(f, r.id));
      setFailed(true);
    }
  };

  const remove = async (id: string) => {
    setFailed(false);
    setGone((g) => ({ ...g, [id]: true }));
    const answer = await page.act({ type: "routine.remove", id });
    if (!answer.ok) {
      setGone((g) => without(g, id));
      setFailed(true);
    }
  };

  return (
    <SubPage title={title} lead={lead} testID="tex-routines">
      {items.length > 0 ? (
        <ListBox>
          {items.map((r) => {
            const on = flips[r.id] ?? r.on;
            const sub = !on && r.pausedSince ? `${r.when} · paused since ${r.pausedSince}` : r.what ? `${r.when} · ${r.what}` : r.when;
            return (
              <ListRow
                key={r.id}
                title={r.title}
                sub={sub}
                testID={`tex-routine-${r.id}`}
                right={
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="switch"
                      aria-checked={on}
                      accessibilityLabel={r.title}
                      onPress={() => void toggle(r, !on)}
                      style={[styles.tog, on ? styles.togOn : styles.togOff]}
                      testID={`tex-routine-toggle-${r.id}`}
                    >
                      <View style={[styles.knob, on ? styles.knobOn : styles.knobOff]} />
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => void remove(r.id)} style={styles.rm} testID={`tex-routine-remove-${r.id}`}>
                      <T size={13} tone="crit">
                        Remove
                      </T>
                    </Pressable>
                  </View>
                }
              />
            );
          })}
        </ListBox>
      ) : null}
      {failed ? <SaveFailed /> : null}
      {group ? null : <Hint>{ROUTINES_HINT}</Hint>}
    </SubPage>
  );
}

/* ---------------------------------------------------------------- Check-ins */

type CheckinEdit = { when: string; what: string } | "gone";

export function CheckinsPage({ source, page, chat, group }: ViewProps) {
  const styles = useThemedStyles(makeStyles);
  const { read } = useTexList(source, chat, "checkins", page.changes);
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const [edits, setEdits] = useState<Record<string, CheckinEdit>>({});
  const [added, setAdded] = useState<CheckIn[]>([]);
  const [showHow, setShowHow] = useState(false);
  const [failed, setFailed] = useState(false);
  const [switchFlips, setSwitchFlips] = useState<Partial<TexSwitches>>({});
  useEffect(() => {
    setEdits({});
    setAdded([]);
    setSwitchFlips({});
  }, [read]);

  const title = group ? `Check-ins in ${group}` : "Check-ins";
  const data = read?.kind === "ok" ? read.value : null;
  if (data === null) return <SubPage title={title} lead={CHECKINS_LEAD} testID="tex-checkins" />;

  const rows = [...added, ...data.items].flatMap((c): CheckIn[] => {
    const e = edits[c.id];
    if (e === "gone") return [];
    return [e ? { ...c, ...e } : c];
  });
  if (group && rows.length === 0) {
    return <SubPage title={title} lead={GROUP_CHECKINS_EMPTY} testID="tex-checkins" />;
  }

  // Only one form open at a time; by default the first check-in not yet done.
  const current = openId === undefined ? (rows.find((c) => !c.done)?.id ?? null) : openId;
  const toggle = (id: string) => setOpenId(current === id ? null : id);

  const saveEdit = async (c: CheckIn, when: string, what: string) => {
    setFailed(false);
    setOpenId(null);
    const was = { when: c.at !== undefined ? whenField(c.at) : "", what: c.what };
    setEdits((e) => ({ ...e, [c.id]: { when: when === was.when ? c.when : when, what } }));
    // Only what changed: the gateway re-arms a check-in whose time is sent.
    const answer = await page.act({
      type: "checkin.edit",
      id: c.id,
      ...(when !== was.when ? { when } : {}),
      ...(what !== was.what ? { what } : {}),
    });
    if (!answer.ok) {
      setEdits((e) => without(e, c.id));
      setFailed(true);
      setOpenId(c.id);
    }
  };

  const cancelEdit = async (c: CheckIn) => {
    setFailed(false);
    setOpenId(null);
    setEdits((e) => ({ ...e, [c.id]: "gone" }));
    const answer = await page.act({ type: "checkin.cancel", id: c.id });
    if (!answer.ok) {
      setEdits((e) => without(e, c.id));
      setFailed(true);
      setOpenId(c.id);
    }
  };

  const addNew = async (when: string, what: string) => {
    const id = `new-${Date.now()}`;
    setFailed(false);
    setOpenId(null);
    setAdded((a) => [...a, { id, when, what }]);
    const answer = await page.act({ type: "checkin.add", when, what });
    if (!answer.ok) {
      setAdded((a) => a.filter((x) => x.id !== id));
      setFailed(true);
      setOpenId("new");
    }
  };

  const flipSwitch = async (name: keyof TexSwitches, on: boolean) => {
    setFailed(false);
    setSwitchFlips((f) => ({ ...f, [name]: on }));
    const answer = await page.act({ type: "switch.set", name, on });
    if (!answer.ok) {
      setSwitchFlips((f) => without(f, name));
      setFailed(true);
    }
  };

  const looks = data.looksAt && data.looksAt.length > 0 ? data.looksAt.join(", ") : null;
  const quiet = data.quietHours || null;

  return (
    <SubPage title={title} lead={CHECKINS_LEAD} testID="tex-checkins">
      {rows.length > 0 ? (
        <ListBox>
          {rows.map((c) =>
            c.done ? (
              <ListRow key={c.id} title={c.when} sub={c.result ? `${c.what} · ${c.result}` : c.what} right={<T size={13} tone="text2">Done</T>} />
            ) : (
              <Fragment key={c.id}>
                <ListRow
                  title={c.when}
                  sub={c.what}
                  onPress={() => toggle(c.id)}
                  testID={`tex-checkin-${c.id}`}
                  right={
                    <T size={13} tone="accent" style={{ opacity: current === c.id ? 0 : 1 }}>
                      Edit
                    </T>
                  }
                />
                {current === c.id ? (
                  <CheckinForm
                    key={`edit-${c.id}`}
                    testID={`tex-checkin-form-${c.id}`}
                    initial={{ when: c.at !== undefined ? whenField(c.at) : "", what: c.what }}
                    onSave={(when, what) => void saveEdit(c, when, what)}
                    onCancel={() => void cancelEdit(c)}
                  />
                ) : null}
              </Fragment>
            ),
          )}
        </ListBox>
      ) : null}
      {failed ? <SaveFailed /> : null}
      <More testID="tex-checkin-add" style={{ paddingTop: 0 }} onPress={() => setOpenId(current === "new" ? null : "new")}>
        + Add a check-in
      </More>
      {current === "new" ? (
        <CheckinForm key="new" testID="tex-checkin-form-new" onSave={(when, what) => void addNew(when, what)} />
      ) : null}
      {looks || quiet ? (
        <>
          <ListBox>
            {looks ? (
              <ListRow
                title="Looks at"
                sub={looks}
                onPress={() => setShowHow((v) => !v)}
                testID="tex-checkins-looks"
                right={<T size={13} tone="accent">Change</T>}
              />
            ) : null}
            {quiet ? (
              <ListRow
                title="Quiet hours"
                sub={quiet}
                onPress={() => setShowHow((v) => !v)}
                testID="tex-checkins-quiet"
                right={<T size={13} tone="accent">Change</T>}
              />
            ) : null}
          </ListBox>
          {showHow ? <Hint>{CHANGE_HINT}</Hint> : null}
        </>
      ) : null}
      {data.switches ? (
        <ListBox>
          {SWITCH_ROWS.map((row) => {
            const on = switchFlips[row.name] ?? data.switches![row.name];
            return (
              <ListRow
                key={row.name}
                title={row.title}
                sub={row.sub}
                testID={`tex-switch-${row.name}`}
                right={
                  <Pressable
                    accessibilityRole="switch"
                    aria-checked={on}
                    accessibilityLabel={row.title}
                    onPress={() => void flipSwitch(row.name, !on)}
                    style={[styles.tog, on ? styles.togOn : styles.togOff]}
                    testID={`tex-switch-toggle-${row.name}`}
                  >
                    <View style={[styles.knob, on ? styles.knobOn : styles.knobOff]} />
                  </Pressable>
                }
              />
            );
          })}
        </ListBox>
      ) : null}
    </SubPage>
  );
}

/** The inline form under a check-in: when, what, and Save (plus cancel, for one that exists). */
function CheckinForm({
  initial,
  onSave,
  onCancel,
  testID,
}: {
  initial?: { when: string; what: string };
  onSave: (when: string, what: string) => void;
  onCancel?: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [when, setWhen] = useState(initial?.when ?? "");
  const [what, setWhat] = useState(initial?.what ?? "");
  const ready = isWhenField(when) && what.trim() !== "";
  return (
    <View style={styles.form} testID={testID}>
      <Field label="When" value={when} onChangeText={setWhen} placeholder="2026-11-03 18:30" testID={`${testID}-when`} />
      <Field label="What Tex does" value={what} onChangeText={setWhat} testID={`${testID}-what`} />
      <View style={styles.fb}>
        <Ghost label="Save" disabled={!ready} onPress={() => onSave(when.trim(), what.trim())} testID={`${testID}-save`} />
        {onCancel ? <Ghost label="Cancel this check-in" danger onPress={onCancel} testID={`${testID}-cancel`} /> : null}
      </View>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const page = useThemedStyles(pageStyles);
  const field = useFieldFont(texPageType.field);
  return (
    <View style={styles.field}>
      <T size={12} tone="muted">
        {label}
      </T>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        style={[page.input, styles.input, field]} testID={testID} />
    </View>
  );
}

/* ---------------------------------------------------------------- About */

export function AboutPage({ source, page, chat, group }: ViewProps) {
  const now = useNow();
  const { read, more } = useTexList(source, chat, "about", page.changes);
  const [open, setOpen] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [gone, setGone] = useState<Record<string, true>>({});
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setTexts({});
    setGone({});
  }, [read]);

  const title = group ? "About the group" : "About you";
  const lead = group
    ? `What Tex knows about ${group}, the one copy it reads in this chat. Only the people here can see it.`
    : ABOUT_LEAD;
  const data = read?.kind === "ok" ? read.value : null;
  if (data === null) return <SubPage title={title} lead={lead} testID="tex-about" />;
  const items = data.items.filter((a) => !gone[a.line]);

  const save = async (a: AboutLine, text: string) => {
    setFailed(false);
    setOpen(null);
    setTexts((t) => ({ ...t, [a.line]: text }));
    const answer = await page.act({ type: "about.fix", line: a.line, text });
    if (!answer.ok) {
      setTexts((t) => without(t, a.line));
      setFailed(true);
      setOpen(a.line);
    }
  };

  const remove = async (a: AboutLine) => {
    setFailed(false);
    setOpen(null);
    setGone((g) => ({ ...g, [a.line]: true }));
    const answer = await page.act({ type: "about.remove", line: a.line });
    if (!answer.ok) {
      setGone((g) => without(g, a.line));
      setFailed(true);
      setOpen(a.line);
    }
  };

  return (
    <SubPage title={title} lead={lead} testID="tex-about">
      {items.length === 0 ? <T size={13} tone="muted">{ABOUT_EMPTY}</T> : null}
      {items.map((a) => (
        <Fragment key={a.line}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setOpen(open === a.line ? null : a.line)}
            testID={`tex-about-${a.line}`}
          >
            <T size={16} serif line={1.55}>
              {texts[a.line] ?? a.text}
            </T>
            <T size={12} tone="muted">
              {`${a.source} · ${day(a.at, new Date(now))}${a.isNew ? " · new" : ""}`}
            </T>
          </Pressable>
          {open === a.line ? (
            <FactEditor
              key={`edit-${a.line}`}
              text={texts[a.line] ?? a.text}
              testID={`tex-about-editor-${a.line}`}
              onSave={(text) => void save(a, text)}
              onRemove={() => void remove(a)}
            />
          ) : null}
        </Fragment>
      ))}
      {failed ? <SaveFailed /> : null}
      {data.total !== undefined && data.total > data.items.length ? (
        <More testID="tex-about-more" onPress={() => void more()}>
          {`Show all ${data.total}`}
        </More>
      ) : null}
    </SubPage>
  );
}

/** The inline editor under an About line: the text, then Save and Remove. */
function FactEditor({ text, onSave, onRemove, testID }: { text: string; onSave: (text: string) => void; onRemove: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  const page = useThemedStyles(pageStyles);
  const [draft, setDraft] = useState(text);
  const field = useFieldFont(texPageType.field);
  return (
    <View style={styles.form} testID={testID}>
      <TextInput accessibilityLabel="Fix this line" value={draft} onChangeText={setDraft} style={[page.input, field]} testID={`${testID}-text`} />
      <View style={styles.fb}>
        <Ghost label="Save" disabled={draft.trim() === ""} onPress={() => onSave(draft.trim())} testID={`${testID}-save`} />
        <Ghost label="Remove" danger onPress={onRemove} testID={`${testID}-remove`} />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    actions: { flexDirection: "row", alignItems: "center", gap: 12 },
    tog: { width: 38, height: 22, borderRadius: 11, flexShrink: 0 },
    togOn: { backgroundColor: colors.accent },
    togOff: { backgroundColor: colors.lineStrong },
    knob: { position: "absolute", top: 3, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.surface },
    knobOn: { right: 3 },
    knobOff: { left: 3 },
    rm: { paddingLeft: 4 },
    form: { gap: 10, paddingTop: 4, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
    field: { gap: 4 },
    input: { paddingHorizontal: 10 },
    fb: { flexDirection: "row", gap: 8 },
  });
