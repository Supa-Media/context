/**
 * Board 13's Try it: chat with a setup as yourself, the open case's rules
 * checked on every reply (decided by the owner, 2026-10-16: "some sort of way
 * that I'm able to test it … like a chatbot").
 *
 * Each message goes to the gateway's `/agent/try` (`apps/mcp/src/agent/tryIt.js`)
 * on the console's own grant for the person's own workspace, so the setup
 * reads their notes and nothing else, and can change none of them. The
 * gateway runs the setup, then a judge turn on the case's `must` / `must not`
 * / `may` / `judge` lines; the checks that need the bench's record (`must
 * call`, …) are left to a real run and said so here.
 */

import { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { Menu } from "../design/components/Menu";
import type { MenuItem } from "../console/files/menuItem";
import { useFieldFont } from "../design/fieldFont";
import { pointerType } from "../design/tokens";
import { useConsoleGrant } from "../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../console/placeholderData";
import { gatewayOriginFrom } from "../meetings/gateway";
import { Box, LinkText, Primary, Quiet, Quietly } from "./AiKit";
import type { TestCase } from "./testList";

/** The rule kinds the gateway's judge checks. */
const JUDGED = new Set(["must", "must not", "may", "judge"]);
const PERSON_STARTS = "person starts";

export interface TryCheck {
  key: string;
  value: string;
  /** `null` when the judge said nothing usable about it. */
  pass: boolean | null;
  why: string;
}

export interface TryExchange {
  setup: string;
  question: string;
  answer: string | null;
  checks: TryCheck[];
  error: string | null;
}

/** One setup Try it can pick: live first, then the experiments, then the archived ones behind "Show archived". */
export interface TrySetup {
  name: string;
  title: string;
  path: string;
  group: "live" | "experiment" | "archived";
  status?: string;
}

/** Who the try is played as: the case's person and what their notes say, or nobody (yourself). */
export interface TryAs {
  who: string;
  notes: string;
}

/** The case's person as Try it plays them: its `as:` line, else the group's `run_as:`; null when it names nobody. */
export function caseAs(testCase: TestCase | null, runAs: string | null): TryAs | null {
  if (testCase === null) return null;
  const who = testCase.person?.value.trim() || runAs?.trim() || "";
  return who === "" ? null : { who, notes: testCase.description };
}

/** The picker's rows: live and the experiments, the archived ones once asked for, and the two switches. */
export function pickerItems(setups: readonly TrySetup[], picked: string | null, showArchived: boolean, sideBySide: boolean): MenuItem<string>[] {
  const shown = setups.filter((item) => item.group !== "archived" || showArchived);
  const archived = setups.filter((item) => item.group === "archived").length;
  const items: MenuItem<string>[] = shown.map((item, index) => ({
    id: item.path,
    label: item.title,
    value: item.group === "live" ? "Live" : item.group === "archived" ? "Archived" : (item.status ?? "Experiment"),
    checked: item.path === picked,
    ...(index > 0 && item.group !== shown[index - 1]!.group ? { separatorBefore: true } : {}),
  }));
  items.push({ id: SIDE_BY_SIDE, label: "Side by side with live", checked: sideBySide, separatorBefore: true });
  if (archived > 0) items.push({ id: SHOW_ARCHIVED, label: showArchived ? "Hide archived" : `Show archived (${archived})`, checked: false });
  return items;
}

const SIDE_BY_SIDE = "__side-by-side";
const SHOW_ARCHIVED = "__show-archived";

/** What `/agent/try` is sent: the chat so far with this setup, and the case's judged rules. */
export function tryBody(setupPath: string, question: string, earlier: readonly TryExchange[], testCase: TestCase | null, as: TryAs | null = null) {
  return {
    ...(as === null ? {} : { as }),
    question,
    setup: setupPath,
    history: earlier
      .filter((item) => item.answer !== null)
      .map((item) => ({ question: item.question, answer: item.answer as string })),
    rules: (testCase?.rules ?? []).filter((rule) => JUDGED.has(rule.key)).map((rule) => ({ key: rule.key, value: rule.value })),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** The case's rules the judge cannot check here, by kind, for one quiet line. */
export function uncheckedRules(testCase: TestCase | null): string[] {
  return (testCase?.rules ?? []).filter((rule) => !JUDGED.has(rule.key)).map((rule) => rule.key);
}

/** What a case's chat starts with: what the person texts first. */
export function firstQuestion(testCase: TestCase | null): string {
  if (testCase === null) return "";
  return testCase.replies.find((line) => line.key === PERSON_STARTS)?.value ?? testCase.title;
}

/** The gateway's answer read into an exchange; anything unexpected is an error line, never a crash. */
export function readTry(setup: string, question: string, status: number, body: unknown): TryExchange {
  const data = (body ?? {}) as { answer?: unknown; checks?: unknown; error_description?: unknown; exhausted?: unknown };
  if (status !== 200 || typeof data.answer !== "string") {
    const said = typeof data.error_description === "string" ? data.error_description : "The try did not finish. Try again.";
    return { setup, question, answer: null, checks: [], error: said };
  }
  const checks = Array.isArray(data.checks)
    ? data.checks.flatMap((check: { key?: unknown; value?: unknown; pass?: unknown; why?: unknown }) =>
        typeof check?.key === "string" && typeof check.value === "string"
          ? [{ key: check.key, value: check.value, pass: typeof check.pass === "boolean" ? check.pass : null, why: typeof check.why === "string" ? check.why : "" }]
          : [],
      )
    : [];
  const answer = data.exhausted === true && data.answer === "" ? "It ran out of steps before answering." : data.answer;
  return { setup, question, answer, checks, error: null };
}

export function AiTryIt({ workspaceId, setups, testCase, runAs = null, onSaveAsCase }: {
  workspaceId: Id<"workspaces">;
  job: string;
  /** The setups to try, live first: their note paths. */
  setups: readonly TrySetup[];
  /** The group's `run_as:`, for a case that names nobody itself. */
  runAs?: string | null;
  /** The case open beside it: its rules are checked on every reply, and its question starts the chat. */
  testCase: TestCase | null;
  /** Turn the exchange into a new case in the open test list. */
  onSaveAsCase: (exchange: { question: string; answer: string }) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const mint = useConsoleGrant();
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  // As yourself: the grant is for your own workspace, so the setup reads your notes.
  const own = workspaces?.find((workspace) => (workspace as { kind?: string }).kind === "personal");
  const asWorkspace = (own?.workspaceId as Id<"workspaces"> | undefined) ?? workspaceId;
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const setup = setups.find((item) => item.path === pickedPath) ?? setups[0] ?? null;
  const live = setups.find((item) => item.group === "live") ?? null;
  const [showArchived, setShowArchived] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [asCase, setAsCase] = useState(false);
  const pickRef = useRef<View>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const persona = caseAs(testCase, runAs);
  const as = asCase ? persona : null;
  const [chat, setChat] = useState<TryExchange[]>([]);
  const [caseNumber, setCaseNumber] = useState<number | null>(testCase?.number ?? null);
  const [draft, setDraft] = useState(firstQuestion(testCase));
  const [busy, setBusy] = useState(false);
  const unchecked = useMemo(() => uncheckedRules(testCase), [testCase]);

  // A different case starts a different chat.
  if ((testCase?.number ?? null) !== caseNumber) {
    setCaseNumber(testCase?.number ?? null);
    setChat([]);
    setDraft(firstQuestion(testCase));
  }

  const send = async (question: string, target: { name: string; path: string }): Promise<void> => {
    const text = question.trim();
    const origin = gatewayOriginFrom(MCP_ENDPOINT);
    if (text === "" || busy || origin === null) return;
    setBusy(true);
    const earlier = chat.filter((item) => item.setup === target.name);
    let next: TryExchange;
    try {
      const grant = await mint({ workspaceId: asWorkspace });
      const response = await fetch(`${origin}/agent/try`, {
        method: "POST",
        headers: { Authorization: `Bearer ${grant.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(tryBody(target.path, text, earlier, testCase, as)),
      });
      next = readTry(target.name, text, response.status, await response.json().catch(() => null));
    } catch {
      next = readTry(target.name, text, 0, null);
    }
    setChat((items) => [...items, next]);
    setDraft("");
    setBusy(false);
  };

  /** Sends to the picked setup and, side by side, to live with the same words. */
  const sendAll = async (question: string) => {
    if (setup === null) return;
    await send(question, setup);
    if (sideBySide && live !== null && live.path !== setup.path) await send(question, live);
  };

  const openMenu = () => {
    pickRef.current?.measureInWindow((x, y, _width, height) => setMenu({ x, y: y + height + 4 }));
    setMenu((was) => was ?? { x: 0, y: 0 });
  };
  const choose = (id: string) => {
    setMenu(null);
    if (id === SIDE_BY_SIDE) setSideBySide((was) => !was);
    else if (id === SHOW_ARCHIVED) setShowArchived((was) => !was);
    else setPickedPath(id);
  };

  if (setup === null) {
    return (
      <Box title="Try it" testID="admin-ai-try">
        <Quietly>This job has no setup to try yet.</Quietly>
      </Box>
    );
  }
  const other = sideBySide ? null : (setups.find((item) => item.name !== setup.name && item.group !== "archived") ?? null);

  return (
    <Box
      title="Try it"
      right={
        persona !== null ? (
          <View style={styles.seg} role="radiogroup">
            {[false, true].map((on) => (
              <Pressable key={String(on)} role="radio" aria-checked={asCase === on} onPress={() => { setAsCase(on); setChat([]); }} style={[styles.segItem, asCase === on && styles.segOn]} testID={`admin-ai-try-as-${on ? "case" : "me"}`}>
                <Text variant="mini" numberOfLines={1} style={asCase === on ? styles.strong : styles.muted}>{on ? `As ${persona.who}` : "As me"}</Text>
              </Pressable>
            ))}
          </View>
        ) : null
      }
      testID="admin-ai-try"
    >
      <Pressable ref={pickRef} role="button" aria-haspopup="menu" onPress={openMenu} style={styles.pick} testID="admin-ai-try-setup">
        <Text variant="rowTitle" numberOfLines={1} style={styles.pickTitle}>{setup.title}</Text>
        <Pill tone={setup.group === "live" ? "ok" : "neutral"}>{setup.group === "live" ? "Live" : setup.group === "archived" ? "Archived" : "Experiment"}</Pill>
        <Text variant="meta" style={styles.muted}>▾</Text>
      </Pressable>
      {menu !== null ? <Menu<string> items={pickerItems(setups, setup.path, showArchived, sideBySide)} anchor={menu} title="Try which setup" onSelect={choose} onDismiss={() => setMenu(null)} /> : null}
      <Quietly>
        {as !== null
          ? `As ${as.who}, knowing only what this case says their notes hold. It changes nothing.`
          : "As you, reading your own notes. It changes nothing."}
        {sideBySide && live !== null && live.path !== setup.path ? " Each text also goes to live." : ""}
      </Quietly>
      <View style={styles.chat}>
        {chat.map((item, index) => (
          <View key={index} style={styles.exchange} testID={`admin-ai-try-exchange-${index}`}>
            <Text variant="meta" style={styles.who}>{`You, to ${item.setup}`}</Text>
            <Text variant="body">{item.question}</Text>
            <Text variant="meta" style={styles.who}>{item.setup}</Text>
            {item.error !== null ? (
              <Text variant="body" style={styles.fail}>{item.error}</Text>
            ) : (
              <Text variant="body" selectable>{item.answer}</Text>
            )}
            {item.checks.map((check, at) => (
              <Text key={at} variant="meta" style={check.pass === false ? styles.fail : check.pass === true ? styles.pass : styles.muted} testID={`admin-ai-try-check-${index}-${at}`}>
                {`${check.pass === null ? "?" : check.pass ? "✓" : "✗"} ${check.key}: ${check.value}${check.why ? ` (${check.why})` : ""}`}
              </Text>
            ))}
            {item.answer !== null ? (
              <View style={styles.links}>
                <LinkText label="Save as a case" onPress={() => onSaveAsCase({ question: item.question, answer: item.answer as string })} testID={`admin-ai-try-save-${index}`} />
                {other !== null && item.setup !== other.name ? (
                  <LinkText label={`Try ${other.title} too`} onPress={() => void send(item.question, other)} testID={`admin-ai-try-other-${index}`} />
                ) : null}
              </View>
            ) : null}
          </View>
        ))}
        {busy ? <Text variant="meta" style={styles.muted}>Thinking…</Text> : null}
      </View>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        placeholder="What the person texts"
        multiline
        style={[styles.input, fieldFont]}
        accessibilityLabel="What the person texts"
        testID="admin-ai-try-input"
      />
      <View style={styles.links}>
        <Primary label={busy ? "Sending…" : "Send"} disabled={busy || draft.trim() === ""} onPress={() => void sendAll(draft)} testID="admin-ai-try-send" />
        {chat.length > 0 ? <Quiet label="Start over" onPress={() => setChat([])} testID="admin-ai-try-reset" /> : null}
      </View>
      {unchecked.length > 0 ? (
        <Quietly>{`Checked on a real run, not here: ${[...new Set(unchecked)].join(", ")}.`}</Quietly>
      ) : null}
    </Box>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chat: { gap: space.x3, marginTop: space.x2 },
    exchange: { gap: 4, paddingLeft: space.x2, borderLeftWidth: 2, borderLeftColor: colors.line },
    who: { color: colors.muted, marginTop: 4 },
    links: { flexDirection: "row", flexWrap: "wrap", gap: space.x3, alignItems: "center", marginTop: 4 },
    input: { minHeight: 64, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space.x2, color: colors.text, marginTop: space.x3 },
    pass: { color: colors.okText },
    fail: { color: colors.critText },
    muted: { color: colors.muted },
    strong: { color: colors.text, fontWeight: "600" },
    pick: { flexDirection: "row", alignItems: "center", gap: space.x2, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x3, paddingVertical: space.x2, minWidth: 0 },
    pickTitle: { flex: 1, minWidth: 0 },
    seg: { flexDirection: "row", borderWidth: 1, borderColor: colors.line, borderRadius: 8, overflow: "hidden" },
    segItem: { paddingHorizontal: space.x2, paddingVertical: 4, maxWidth: 140 },
    segOn: { backgroundColor: colors.rowSelected },
  });
