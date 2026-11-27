/**
 * A bot's health, one word and one line why, from what every workspace member can already read: its webhook row
 * (`apps/convex/functions/botHooks.ts` `botHookList`: last call, its HTTP reply), when it last checked in
 * (`orient { check: true }`, the state's `checks`) and the last run of each routine sent to it (`areaRoutines.ts`:
 * outcome, answeredAt). A bot reaches Context one of two ways: a webhook Context calls, or checking in every 5 minutes
 * for what is new (Dev, 2026-11-27: "as long as the agent is pinging every 5 minutes it can be in good standing").
 *
 * A bot with a webhook row:
 *   last call failed or didn't reach                 → Webhook failing  (crit)
 *   a routine sent >1 h ago this week, no answer yet → Not answering    (warn)
 *   never called                                     → Not tried yet    (grey)
 *   a routine answered this week, or a check-in now  → Answering        (ok)
 *   otherwise: calls land, nothing answered yet      → Reachable        (ok)
 * A delivered call is not an answer (Dev, 2026-11-27: "fix these PLEASE"): a Grok bot's webhook took every routine
 * while the bot answered none until its person wrote in its chat, and the card said Answering.
 * A bot with none whose card says `reach: mail`, or that has checked in:
 *   never checked in                                 → Not checking yet (grey, hollow)
 *   no check in 10 minutes                           → Stopped checking (crit)
 *   a routine sent >1 h ago this week, no answer yet → Not answering    (warn)
 *   otherwise                                        → Checking         (ok)
 * Any other bot                                      → Not set up       (grey, hollow)
 */

import { createContext, useContext, type ReactNode } from "react";
import { mailJoinName } from "@context/shared/src/areaBots.cjs";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { clockAt, type RoutineStateNow } from "./areaRoutines";
import { cardSlug } from "./seat";
import type { HookRow } from "./PanelBotHook";

export type HealthState = "not set up" | "webhook failing" | "not answering" | "not tried" | "reachable" | "answering" | "not checking" | "stopped checking" | "checking";
export type HealthTone = "ok" | "warn" | "crit" | "quiet";

export interface RunFacts {
  readonly lastAt: number | null;
  readonly outcome: "sent" | "held" | "no_bot" | "failed" | null;
  readonly answeredAt: number | null;
}

export interface BotHealth {
  readonly state: HealthState;
  readonly tone: HealthTone;
  /** "Answering", "Webhook failing". */
  readonly word: string;
  /** One line why: "Last call answered (200) · today 9:04 am". */
  readonly why: string;
  /** "3 of 4 routines answered this week", or null with none sent this week. */
  readonly routines: string | null;
  /** The bad states, which the list sorts first within a group. */
  readonly bad: boolean;
  /** How Context reaches it: its webhook, its check-ins, or nothing yet. */
  readonly via: "webhook" | "check" | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Two missed check-ins: a bot asked to check every 5 minutes that hasn't in 10 has stopped. */
export const CHECK_STALE_MS = 10 * MINUTE;
const WEEK = 7 * 24 * HOUR;

/** How the bot reaches Context: its card's `reach` and when it last checked in, if ever. */
export interface ReachFacts {
  readonly reach?: string | null;
  readonly checkedAt?: number | null;
}

const ago = (at: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE));
  return minutes === 0 ? "just now" : `${minutes} min ago`;
};

export function botHealth(row: HookRow | null, runs: readonly RunFacts[], now: number, reach: ReachFacts = {}): BotHealth {
  const week = runs.filter((run) => run.lastAt !== null && now - run.lastAt < WEEK && (run.outcome === "sent" || run.outcome === "failed"));
  const answered = week.filter((run) => run.answeredAt !== null).length;
  const missed = week.filter((run) => run.answeredAt === null && run.lastAt !== null && now - run.lastAt > HOUR).length;
  const routines = week.length === 0 ? null : `${answered} of ${week.length} routine${week.length === 1 ? "" : "s"} answered this week`;
  const when = row?.lastCallAt == null ? "" : ` · ${clockAt(row.lastCallAt, now)}`;
  const checkedAt = reach.checkedAt ?? null;
  if (row === null && (reach.reach === "mail" || checkedAt !== null)) {
    if (checkedAt === null) return { state: "not checking", tone: "quiet", word: "Not checking yet", why: "It hasn't checked in yet.", routines, bad: true, via: "check" };
    if (now - checkedAt > CHECK_STALE_MS) return { state: "stopped checking", tone: "crit", word: "Stopped checking", why: `Last check ${clockAt(checkedAt, now)}`, routines, bad: true, via: "check" };
    if (missed > 0) return { state: "not answering", tone: "warn", word: "Not answering", why: `It checks in, but ${missed === 1 ? "a routine has" : `${missed} routines have`} no answer.`, routines, bad: true, via: "check" };
    return { state: "checking", tone: "ok", word: "Checking", why: `Checks every 5 min · last check ${ago(checkedAt, now)}`, routines, bad: false, via: "check" };
  }
  if (row === null) return { state: "not set up", tone: "quiet", word: "Not set up", why: "No webhook, and it hasn't checked in, so nothing reaches it yet.", routines: null, bad: true, via: null };
  if (row.lastCallAt !== null && row.lastCallOk === false) {
    const why = row.lastCallStatus === 0 || row.lastCallStatus === null ? `Last call didn't reach it${when}` : `Last call failed (${row.lastCallStatus})${when}`;
    return { state: "webhook failing", tone: "crit", word: "Webhook failing", why, routines, bad: true, via: "webhook" };
  }
  if (missed > 0) {
    return { state: "not answering", tone: "warn", word: "Not answering", why: `Its webhook takes calls, but ${missed === 1 ? "a routine has" : `${missed} routines have`} no answer.`, routines, bad: true, via: "webhook" };
  }
  if (row.lastCallAt === null) return { state: "not tried", tone: "quiet", word: "Not tried yet", why: "Webhook saved. Nothing has called it yet.", routines, bad: false, via: "webhook" };
  // Answering is the bot's own answer, or its own check-in: its webhook taking a call says only that the call landed.
  const lastAnswer = Math.max(...week.map((run) => run.answeredAt ?? 0));
  if (answered > 0) return { state: "answering", tone: "ok", word: "Answering", why: `Last routine answered ${clockAt(lastAnswer, now)}`, routines, bad: false, via: "webhook" };
  if (checkedAt !== null && now - checkedAt <= CHECK_STALE_MS) return { state: "answering", tone: "ok", word: "Answering", why: `Checks every 5 min · last check ${ago(checkedAt, now)}`, routines, bad: false, via: "webhook" };
  const waiting = week.length > 0 ? " No answer yet." : " No routines this week.";
  return { state: "reachable", tone: "ok", word: "Reachable", why: `Webhook took the last call (${row.lastCallStatus})${when}.${waiting}`, routines, bad: false, via: "webhook" };
}

/** What a page knows of every bot: its webhook row (null for none, undefined while asking) and its health. */
export interface BotLookups {
  readonly hookRowOf: (bot: string) => HookRow | null | undefined;
  /** Its health; `reach` is its card's, where the caller has the card. */
  readonly healthOf: (bot: string, reach?: string | null) => BotHealth | undefined;
}

const NOTHING: BotLookups = { hookRowOf: () => undefined, healthOf: () => undefined };

/**
 * The lookups from the workspace's webhook list (`botHookList`, which every member reads; undefined while asking)
 * and its routine state (`useAreaRoutineState`). A routine counts for the bot it was sent to; the state names it by
 * its mail name, as the webhook list does.
 */
export function botLookups(rows: readonly HookRow[] | undefined, state: RoutineStateNow, now: number): BotLookups {
  if (rows === undefined) return NOTHING;
  const key = (name: string) => cardSlug(mailJoinName(name));
  const hookRowOf = (bot: string) => rows.find((row) => key(row.bot) === key(bot)) ?? null;
  const runs = state === null || state === "loading" ? [] : state.routines;
  const checks = state === null || state === "loading" ? [] : (state.checks ?? []);
  return {
    hookRowOf,
    healthOf: (bot, reach) =>
      botHealth(hookRowOf(bot), runs.filter((run) => run.bot !== null && key(run.bot) === key(bot)), now, {
        reach: reach ?? null,
        checkedAt: checks.find((check) => key(check.bot) === key(bot))?.at ?? null,
      }),
  };
}

const BotLookupsContext = createContext<BotLookups>(NOTHING);

/** Gives everything under it the page's lookups; absent ones leave health unknown, drawn as nothing. */
export function BotLookupsScope({ lookups, children }: { lookups: BotLookups | undefined; children: ReactNode }) {
  return lookups === undefined ? <>{children}</> : <BotLookupsContext.Provider value={lookups}>{children}</BotLookupsContext.Provider>;
}

export const useBotHealth = (bot: string | null, reach?: string | null): BotHealth | undefined => {
  const { healthOf } = useContext(BotLookupsContext);
  return bot === null ? undefined : healthOf(bot, reach);
};

/** The states where nothing reaches the bot yet, so Context has nothing to send it to. */
export const unreachable = (health: BotHealth | undefined) => health?.state === "not set up" || health?.state === "not checking";

export const useBotHookRow = (bot: string): HookRow | null | undefined => useContext(BotLookupsContext).hookRowOf(bot);

const toneColor = (colors: Colors, tone: HealthTone) => (tone === "ok" ? colors.ok : tone === "warn" ? colors.warn : tone === "crit" ? colors.crit : colors.muted);

/** The dot: filled in its tone; hollow for Not set up. */
export function HealthDot({ health, size = 8 }: { health: BotHealth; size?: number }) {
  const colors = useColors();
  const color = toneColor(colors, health.tone);
  const hollow = health.state === "not set up" || health.state === "not checking";
  return <View aria-hidden style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: color, backgroundColor: hollow ? "transparent" : color, flexShrink: 0 }} />;
}

/** Dot and word, as one line: "● Answering". The word takes the tone's text colour unless it is fine. */
export function HealthWord({ health, strong = false, testID }: { health: BotHealth; strong?: boolean; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const ink = health.tone === "warn" ? colors.warnText : health.tone === "crit" ? colors.critText : health.tone === "ok" && strong ? colors.okText : strong ? colors.text : colors.muted;
  return (
    <View style={styles.line} testID={testID} accessibilityLabel={health.word}>
      <HealthDot health={health} />
      <Text variant={strong ? "tree" : "treeMeta"} style={[{ color: ink }, strong && styles.strong]} numberOfLines={1}>
        {health.word}
      </Text>
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    line: { flexDirection: "row", alignItems: "center", gap: 6 },
    strong: { fontWeight: "600" },
  });
