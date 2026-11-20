/**
 * Tex asks Tex across chats, the texting Worker's half (Dev2, 2026-11-17; design
 * https://claude.ai/artifact/N3ZawPjhhgYcNfHm7xWa37; gateway `apps/mcp/src/agent/crossChat.js`;
 * decision `docs/decisions/texting-assistant/cross-chat-asks.md`).
 *
 *     the asking chat's turn answers with `crossAsks` (the Cross-chat gate let each go)
 *       │  kept here as `xask:<id>`, open, counted for the gate's limits, its timeout armed
 *       ├─▶ the other chat's object, `/cross-ask`: queued there as a turn of its own (`chat_ask`), as its asker's tag
 *       │   in a group, as a turn by code in a person's 1:1 (refused when they never texted Tex on their own)
 *       │     its turn answers with `crossBack` (node "Answer the other chat"), never texted there
 *       ◀─┘ `/cross-answer` here: the record is settled and the answer queued as this chat's own turn (`chat_answer`)
 *
 * A refusal and a timeout (10 minutes) come back the same way, as a run naming why. Nothing here keeps an ask's
 * words past its answer: the record keeps the ask's own line, and is dropped a day after it settles. Every step is
 * logged (`log`), and the turns themselves log every node on the gateway.
 */

import { TEX_CONFIG as bundled } from "../../../packages/tex/src/texConfig.cjs";
import { queueByCode, CHAT_KEY, type InboxStorage, type RememberedChat } from "./inbox";
import { queueGroupByCode, groupInboxName } from "./groupInbox";
import { sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";

export const CROSS_PREFIX = "xask:";
const SENT_KEY = "xsent";
export const CROSS_TIMEOUT_MS = 10 * 60_000;
const KEPT_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A group's run for another chat's ask runs as a routine's does (no ack, no progress lines, no binding of its own). */
export const CROSS_ASK_PATH = "(another chat's ask)";

const ID = /^x[A-Za-z0-9_-]{8,40}$/;
const KEY = /^[A-Za-z0-9_-]{6,128}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_WHAT = 600;
const MAX_TEXT = 4_000;

export type CrossTarget = { kind: "group"; key: string; name?: string } | { kind: "person"; who: string };
/** An ask the gateway's Cross-chat gate let go (`crossChatGate.js`). */
export type CrossAsk = { id: string; pair: string; to: CrossTarget; what: string; do: boolean };
/** What an ask-run hands back (node `chatAnswer`). */
export type CrossBack = { id: string; state: "answered" | "refused"; texts: string[]; why?: string };
export type CrossState = "answered" | "refused" | "timeout";
/** What a chat's turn is started with (`chat_ask` or `chat_answer`), as the gateway reads it (`crossChatOf`). */
export type CrossEvent =
  | { kind: "ask"; id: string; from: string; what: string; do: boolean; key?: string; reply: string }
  | { kind: "answer"; id: string; from: string; what: string; state: CrossState; texts: string[]; why?: string; key?: string };

/** Where the asking chat's answer-run is queued: a 1:1 by code, or a group as its asker's tag. */
type Back = { kind: "one"; chatId: string; from: string; channel?: "simulator" } | { kind: "group"; groupId: string; line: string; from: string };
type CrossRecord = { id: string; pair: string; to: CrossTarget; what: string; at: number; state: "open" | CrossState; back: Back; settledAt?: number };

const line = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function log(event: string, id?: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: `cross_chat_${event}`, ...(id ? { id } : {}), ...extra }));
}

/** Whether the config (or a Lab draft's, `env.TEX_GRAPH`) wires the Cross-chat gate: else no chat counts or asks. */
export function crossWired(graph?: unknown): boolean {
  const config = (graph ?? bundled) as { edges?: { from: string; to: string }[] };
  return Array.isArray(config.edges) && config.edges.some((edge) => edge.from === "tools" && edge.to === "crossChatGate");
}

/** The answer's `crossAsks`, read strictly. */
export function readCrossAsks(value: unknown): CrossAsk[] {
  if (!Array.isArray(value)) return [];
  const asks: CrossAsk[] = [];
  for (const raw of value.slice(0, 3)) {
    const ask = raw as Partial<CrossAsk> & { to?: Partial<{ kind: string; key: string; name: string; who: string }> };
    if (!ask || typeof ask.id !== "string" || !ID.test(ask.id) || typeof ask.pair !== "string" || ask.pair.length > 160) continue;
    const what = line(ask.what, MAX_WHAT);
    if (what === "") continue;
    const to: CrossTarget | null =
      ask.to?.kind === "group" && typeof ask.to.key === "string" && KEY.test(ask.to.key)
        ? { kind: "group", key: ask.to.key, ...(line(ask.to.name, 80) ? { name: line(ask.to.name, 80) } : {}) }
        : ask.to?.kind === "person" && typeof ask.to.who === "string" && ask.to.who !== ""
          ? { kind: "person", who: line(ask.to.who, 64) }
          : null;
    if (to !== null) asks.push({ id: ask.id, pair: ask.pair, to, what, do: ask.do === true });
  }
  return asks;
}

/** The answer's `crossBack`, read strictly. */
export function readCrossBack(value: unknown): CrossBack | null {
  const back = value as Partial<CrossBack> | null;
  if (!back || typeof back !== "object" || typeof back.id !== "string" || !ID.test(back.id)) return null;
  if (back.state !== "answered" && back.state !== "refused") return null;
  const texts = (Array.isArray(back.texts) ? back.texts : []).filter((text): text is string => typeof text === "string" && text.trim() !== "").slice(0, 6).map((text) => text.trim().slice(0, MAX_TEXT));
  const why = line(back.why, 300);
  return { id: back.id, state: back.state, texts, ...(why ? { why } : {}) };
}

/** What this chat holds of its asks, for the gate: this hour's, today's, and the pairs still waiting. */
export async function crossCounts(storage: InboxStorage, now: number): Promise<{ hour: number; day: number; open: string[] }> {
  const sent = ((await storage.get<number[]>(SENT_KEY)) ?? []).filter((at) => now - at < DAY_MS);
  const open: string[] = [];
  for (const record of (await storage.list<CrossRecord>({ prefix: CROSS_PREFIX })).values()) if (record.state === "open") open.push(record.pair);
  return { hour: sent.filter((at) => now - at < HOUR_MS).length, day: sent.length, open };
}

/** A POST to one of this Worker's inboxes by name, or a GET when `body` is null. */
type Call = (inbox: string, path: string, body: unknown) => Promise<Response>;
export type CrossDeps = { now: () => number; call: Call };

/** Where the other side's answer comes back to, and how its run is queued here. */
export type CrossOrigin = { kind: "one"; chatId: string; from: string; channel?: "simulator" } | { kind: "group"; message: Pick<GroupMessage, "groupId" | "line" | "from"> };

/**
 * Send each ask the turn's answer carried. A target that can't be reached, or refuses, is settled here at once: its
 * refusal comes back as this chat's own run, so the person hears why.
 */
export async function sendCrossAsks(storage: InboxStorage, deps: CrossDeps, origin: CrossOrigin, asks: CrossAsk[]): Promise<void> {
  if (asks.length === 0) return;
  const now = deps.now();
  const own = origin.kind === "one" ? origin.from : groupInboxName(origin.message.groupId);
  const back: Back = origin.kind === "one" ? { kind: "one", chatId: origin.chatId, from: origin.from, ...(origin.channel ? { channel: origin.channel } : {}) } : { kind: "group", groupId: origin.message.groupId, line: origin.message.line, from: origin.message.from };
  const key = origin.kind === "group" ? await sha256Hex(`${origin.message.line}:${origin.message.groupId}`) : undefined;
  const sent = ((await storage.get<number[]>(SENT_KEY)) ?? []).filter((at) => now - at < DAY_MS);
  for (const ask of asks) {
    if ((await storage.get(`${CROSS_PREFIX}${ask.id}`)) !== undefined) continue; // one ask, one send
    await storage.put<CrossRecord>(`${CROSS_PREFIX}${ask.id}`, { id: ask.id, pair: ask.pair, to: ask.to, what: ask.what, at: now, state: "open", back });
    sent.push(now);
    await storage.put(SENT_KEY, sent);
    const event = { id: ask.id, what: ask.what, do: ask.do, reply: own, from: origin.kind === "one" ? "their own 1:1 chat with you" : "a group chat they're in", ...(key ? { key } : {}) };
    let outcome = "unreached";
    try {
      const target = ask.to.kind === "group" ? await deps.call(`group-key:${ask.to.key}`, "/chat-where", null) : null;
      const where = target === null ? null : ((await target.json().catch(() => null)) as { line?: string; groupId?: string } | null);
      if (ask.to.kind === "group" && (typeof where?.groupId !== "string" || typeof where?.line !== "string")) outcome = "no_chat";
      else {
        const inbox = ask.to.kind === "group" ? groupInboxName(where!.groupId!) : origin.kind === "group" ? origin.message.from : "";
        const response = await deps.call(inbox, "/cross-ask", { ...event, asker: origin.kind === "one" ? origin.from : origin.message.from, ...(ask.to.kind === "group" ? { groupId: where!.groupId, line: where!.line } : {}) });
        outcome = response.ok ? (((await response.json().catch(() => null)) as { outcome?: string } | null)?.outcome ?? "unreached") : "unreached";
      }
    } catch {
      outcome = "unreached";
    }
    log("sent", ask.id, { to: ask.to.kind, outcome });
    if (outcome !== "queued") await settle(storage, ask.id, { state: "refused", texts: [], why: refusedWhy(outcome) }, now);
  }
  await storage.setAlarm(now + CROSS_TIMEOUT_MS);
}

function refusedWhy(outcome: string): string {
  if (outcome === "no_chat") return "that group chat hasn't been heard from on this line yet";
  if (outcome === "no_1to1") return "they have never texted Tex on their own, so they have no personal Tex to ask";
  if (outcome === "full") return "that chat is too busy right now";
  return "that chat couldn't be reached";
}

/** `/cross-ask` in the other chat's object: queue the ask as a turn of this chat's own. */
export async function takeCrossAsk(storage: InboxStorage, body: unknown, now: number): Promise<"queued" | "no_1to1" | "full" | "bad"> {
  const ask = body as { id?: unknown; what?: unknown; do?: unknown; reply?: unknown; from?: unknown; key?: unknown; asker?: unknown; groupId?: unknown; line?: unknown } | null;
  if (!ask || typeof ask.id !== "string" || !ID.test(ask.id) || typeof ask.reply !== "string" || ask.reply.length > 300 || typeof ask.asker !== "string" || !E164.test(ask.asker)) return "bad";
  const what = line(ask.what, MAX_WHAT), from = line(ask.from, 80);
  if (what === "" || from === "") return "bad";
  const event: CrossEvent = { kind: "ask", id: ask.id, from, what, do: ask.do === true, reply: ask.reply, ...(typeof ask.key === "string" && KEY.test(ask.key) ? { key: ask.key } : {}) };
  const eventId = `cross-ask:${ask.id}`;
  if (typeof ask.groupId === "string" && typeof ask.line === "string") {
    // As its asker's tag, only while they are still in the chat, as a routine is: the control plane checks it again.
    const message: GroupMessage = { kind: "group-message", eventId, groupId: ask.groupId, line: ask.line, from: ask.asker, participants: [], messageId: "", text: what, routine: { runId: `xask:${ask.id}`, path: CROSS_ASK_PATH }, crossChat: event };
    const queued = await queueGroupByCode(storage, message, now);
    log(queued === "queued" ? "taken" : "full", ask.id, { at: "group" });
    return queued;
  }
  const chat = await storage.get<RememberedChat>(CHAT_KEY);
  if (!chat || typeof chat.chatId !== "string" || chat.chatId === "") return log("no_1to1", ask.id), "no_1to1";
  await queueByCode(storage, { kind: "message", eventId, chatId: chat.chatId, from: ask.asker, messageId: "", text: what, event: "chat_ask", crossChat: event, ...(chat.channel === "simulator" ? { channel: "simulator" as const } : {}) }, now);
  log("taken", ask.id, { at: "one" });
  return "queued";
}

/** After an ask-run: its answer goes back to the chat that asked (`/cross-answer`). Throws when it couldn't, so the turn is tried again. */
export async function answerCrossAsk(deps: CrossDeps, event: Extract<CrossEvent, { kind: "ask" }>, back: CrossBack): Promise<void> {
  const response = await deps.call(event.reply, "/cross-answer", { id: event.id, state: back.state, texts: back.texts, ...(back.why ? { why: back.why } : {}) });
  log(response.ok ? "answered" : "answer_unreached", event.id, { state: back.state });
  if (!response.ok) throw new Error("cross-chat answer not taken");
}

/** `/cross-answer` in the asking chat's object: settle the ask, and queue its answer as this chat's own run. */
export async function takeCrossAnswer(storage: InboxStorage, body: unknown, now: number): Promise<"queued" | "unknown" | "bad"> {
  const back = readCrossBack(body);
  if (back === null) return "bad";
  return (await settle(storage, back.id, { state: back.state, texts: back.texts, ...(back.why ? { why: back.why } : {}) }, now)) ? "queued" : "unknown";
}

/** On the alarm: asks still open past the timeout come back as "didn't answer in time"; settled ones a day old go. */
export async function crossTimeouts(storage: InboxStorage, now: number): Promise<void> {
  for (const [key, record] of await storage.list<CrossRecord>({ prefix: CROSS_PREFIX })) {
    if (record.state === "open" && now - record.at >= CROSS_TIMEOUT_MS) await settle(storage, record.id, { state: "timeout", texts: [] }, now);
    else if (record.state !== "open" && now - (record.settledAt ?? record.at) >= KEPT_MS) await storage.delete(key);
  }
}

/** Settle an open ask once, and queue its answer-run here. False when there is no open ask by that id. */
async function settle(storage: InboxStorage, id: string, result: { state: CrossState; texts: string[]; why?: string }, now: number): Promise<boolean> {
  const record = await storage.get<CrossRecord>(`${CROSS_PREFIX}${id}`);
  if (record === undefined || record.state !== "open") return false;
  await storage.put<CrossRecord>(`${CROSS_PREFIX}${id}`, { ...record, state: result.state, settledAt: now });
  const label = record.to.kind === "group" ? record.to.name ?? "a group chat of theirs" : `@${record.to.who}'s personal Tex`;
  const event: CrossEvent = { kind: "answer", id, from: label, what: record.what, state: result.state, texts: result.texts, ...(result.why ? { why: result.why } : {}), ...(record.to.kind === "group" ? { key: record.to.key } : {}) };
  const eventId = `cross-answer:${id}`;
  if (record.back.kind === "group") {
    await queueGroupByCode(storage, { kind: "group-message", eventId, groupId: record.back.groupId, line: record.back.line, from: record.back.from, participants: [], messageId: "", text: record.what, routine: { runId: `xask:${id}`, path: CROSS_ASK_PATH }, crossChat: event }, now);
  } else {
    await queueByCode(storage, { kind: "message", eventId, chatId: record.back.chatId, from: record.back.from, messageId: "", text: record.what, event: "chat_answer", crossChat: event, ...(record.back.channel ? { channel: record.back.channel } : {}) }, now);
  }
  log("settled", id, { state: result.state });
  return true;
}

/** The body fields a turn started by a cross-chat event sends the gateway. */
export function crossFields(event: CrossEvent | undefined): { event?: "chat_ask" | "chat_answer"; crossChat?: Omit<CrossEvent, "reply"> } {
  if (event === undefined) return {};
  const { reply: _reply, ...shown } = event as CrossEvent & { reply?: string };
  return { event: event.kind === "ask" ? "chat_ask" : "chat_answer", crossChat: shown };
}
