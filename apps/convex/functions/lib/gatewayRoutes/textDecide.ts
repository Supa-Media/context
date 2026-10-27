/**
 * The texting Worker's decision route (`docs/design/tex-event-log/CONTRACT.md` section 3): whether Tex stays
 * silent, reacts or answers in a chat, which messages an answer covers, what a text sent mid-turn does, which held
 * asks it makes stale, and whether the chat has moved on. Behind `AGENT_WORKER_SECRET`, like the rest of
 * `/agent-texts/*`; asked of the decision model through `withJev` as `textDecide`, typed questions only.
 *
 * Group chats (and the engagement choice, `/agent-texts/group/engagement`) are named by `line` and `chat` (the
 * group id), hashed as `/agent-texts/group` hashes them; a 1:1 text by its `sender`. The transcript is never
 * returned, stored or logged: the one log line carries counts and codes.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { ENGAGEMENT_STYLES, groupKeyOf, type Engagement } from "../../textGroups";
import { badRequest, json, stringField } from "../gatewayAuth";
import { withJev, type JevAnswers, type JevRequest } from "../jev/client";

export const STYLES = [...ENGAGEMENT_STYLES, "direct"] as const;
export type Style = (typeof STYLES)[number];
export const MAX_TRANSCRIPT = 24_000;
export const MAX_CANDIDATES = 32;
export const MAX_WAITING_ASKS = 8;
/** At or above this a waiting ask is stale: the model may end an ask sooner, so it has to be fairly sure. */
/** High on purpose: a side text ("one sec") must never drop a held email; a correction scores far above this. */
export const STALE_AT = 0.85;
/** Sendblue's group ids are uuids; anything much longer is not one (as `/agent-texts/group`). */
const MAX_CHAT = 200;
/** `${at padded to 13}-${seq padded to 6}` (contract section 1). */
const EVENT_ID = /^\d{13}-\d{6}$/;

export interface DecideBody {
  chat: string;
  style: Style;
  transcript: string;
  candidates: string[];
  running: boolean;
  waitingAsks: string[];
  newest: string;
  /** Groups: the line the chat is on, so the row is found by the same hash. */
  line?: string;
  /** 1:1: the person's number, so their personal workspace is metered. */
  sender?: string;
}

export type DecideResult =
  | { ok: true; act: "silent" | "react" | "answer"; covers: string[]; midTurn?: "fold" | "queue" | "restart"; stale: string[]; movedOn: boolean; confidence: number }
  | { ok: false; reason: "capped" | "off" | "unavailable" };

function idList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  if (!value.every((id) => typeof id === "string" && EVENT_ID.test(id))) return null;
  return [...new Set(value as string[])];
}

/** The body as the contract shapes it, or null. A trust boundary: every set closed, every length capped. */
export function readDecideBody(body: Record<string, unknown>): DecideBody | null {
  const chat = stringField(body, "chat");
  const transcript = body.transcript;
  const style = body.style;
  const newest = stringField(body, "newest");
  const candidates = idList(body.candidates, MAX_CANDIDATES);
  const waitingAsks = idList(body.waitingAsks ?? [], MAX_WAITING_ASKS);
  if (chat === null || chat.length > MAX_CHAT) return null;
  if (typeof transcript !== "string" || transcript.length === 0 || transcript.length > MAX_TRANSCRIPT) return null;
  if (typeof style !== "string" || !(STYLES as readonly string[]).includes(style)) return null;
  if (newest === null || !EVENT_ID.test(newest) || candidates === null || !candidates.includes(newest)) return null;
  if (waitingAsks === null || typeof body.running !== "boolean") return null;
  const line = stringField(body, "line");
  const sender = stringField(body, "sender");
  // A group is found by its line; a 1:1 text by its sender.
  if (style === "direct" ? sender === null : line === null) return null;
  return {
    chat,
    style: style as Style,
    transcript,
    candidates,
    running: body.running,
    waitingAsks,
    newest,
    ...(line !== null ? { line } : {}),
    ...(sender !== null ? { sender } : {}),
  };
}

const STYLE_RULES: Record<Style, string> = {
  quiet: "This group chose quiet: Tex answers only a message addressed to Tex by name or a reply to Tex. Anything else is silent.",
  attentive:
    "This group chose attentive: Tex answers a message addressed to it, and the asker's own follow-ups while Tex is waiting on their ask. Talk between the others is silent.",
  followAlong:
    "This group chose follow along: after Tex has spoken, Tex answers an untagged message that continues what it was asked or plainly asks it something. Talk between the people themselves is silent.",
  helpful:
    "This group chose helpful: Tex may answer any message it can genuinely help with, but stays silent on chatter between people that needs nothing from it.",
  direct:
    "This is a one-to-one chat with Tex: every message is to Tex. Answer, unless the newest message is a pure acknowledgement (a tapback, \"ok\", \"thanks\") that asks nothing: only then silent, or a react.",
};

/** The typed questions, at most 16: act, start, midTurn when a turn runs, one per waiting ask, movedOn. */
export function decideRequest(body: DecideBody): JevRequest {
  const questions: Record<string, unknown> = {
    act: {
      type: "choice",
      instructions: `The state is a chat transcript, newest last; each line starts with its event id in angle brackets; "You" is Tex, an assistant in the chat. Decide what Tex does about the newest message (event <${body.newest}>). ${STYLE_RULES[body.style]}`,
      criteria: {
        silent: "Tex says nothing",
        react: "Tex only reacts with a tapback: the message acknowledges or thanks Tex and needs no words",
        answer: "Tex replies in words",
      },
    },
    start: {
      type: "choice",
      instructions: "Which message does the request Tex is answering start at?",
      criteria: Object.fromEntries(body.candidates.map((id) => [id, `the message on the line starting <${id}>`])),
    },
  };
  if (body.running) {
    questions.midTurn = {
      type: "choice",
      instructions: "Tex is in the middle of answering. What should the newest message do to that answer?",
      criteria: {
        fold: "fold: it continues the same request or adds detail to it",
        queue: "queue: it is a new, separate request to answer after the current one",
        restart: "restart: it changes or cancels what Tex is doing",
      },
    };
  }
  body.waitingAsks.forEach((id, index) => {
    questions[`stale_${index}`] = {
      type: "noul",
      instructions: `Tex is holding an action for a yes (event <${id}>). Does the newest message clearly cancel or change this held action? A side remark, a delay ("one sec"), or a question about it is not a change.`,
      criteria: { true: "yes, it cancels or changes the held action", false: "no, the held action still stands as asked" },
    };
  });
  questions.movedOn = {
    type: "noul",
    instructions: "Has the conversation moved on from Tex: are the people now talking among themselves about something else?",
    criteria: { true: "yes, they have moved on from Tex", false: "no, they are still talking with or about what Tex said" },
  };
  return { state: body.transcript, questions };
}

function answerOf(answers: JevAnswers, name: string): Record<string, unknown> | null {
  const answer = answers[name];
  return answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>) : null;
}

function noulOf(answers: JevAnswers, name: string): number | null {
  const noul = answerOf(answers, name)?.noul;
  return typeof noul === "number" && Number.isFinite(noul) ? noul : null;
}

/** The model's answers as the contract's response; anything missing or off the sets is "unavailable", never a guess. */
export function readDecideAnswers(body: DecideBody, answers: JevAnswers): DecideResult {
  const act = answerOf(answers, "act");
  const choice = act?.choice;
  if (choice !== "silent" && choice !== "react" && choice !== "answer") return { ok: false, reason: "unavailable" };
  const confidence = typeof act?.confidence === "number" && Number.isFinite(act.confidence) ? act.confidence : 0;
  // An answer covers the request from where it starts through the newest message, in id order; a start that is not
  // a candidate (or comes after newest) covers just the newest. Silent and react cover nothing.
  const start = answerOf(answers, "start")?.choice;
  const ordered = [...body.candidates].sort();
  const from = typeof start === "string" && start <= body.newest ? ordered.indexOf(start) : -1;
  const covers = choice !== "answer" ? [] : from < 0 ? [body.newest] : ordered.slice(from, ordered.indexOf(body.newest) + 1);
  let midTurn: "fold" | "queue" | "restart" | undefined;
  if (body.running) {
    const mid = answerOf(answers, "midTurn")?.choice;
    if (mid !== "fold" && mid !== "queue" && mid !== "restart") return { ok: false, reason: "unavailable" };
    midTurn = mid;
  }
  const stale = body.waitingAsks.filter((_, index) => (noulOf(answers, `stale_${index}`) ?? 0) >= STALE_AT);
  const movedOn = (noulOf(answers, "movedOn") ?? 0) >= 0.5;
  return { ok: true, act: choice, covers, ...(midTurn !== undefined ? { midTurn } : {}), stale, movedOn, confidence };
}

async function workspaceFor(ctx: ActionCtx, body: DecideBody): Promise<Id<"workspaces"> | null> {
  if (body.style === "direct") return await ctx.runQuery(internal.functions.textLinks.textsDecideWorkspace, { phone: body.sender! });
  return await ctx.runQuery(internal.functions.textGroups.groupDecideWorkspace, { groupKey: await groupKeyOf(body.line!, body.chat) });
}

export async function agentTextsDecideHandler(ctx: ActionCtx, raw: Record<string, unknown>): Promise<Response> {
  const body = readDecideBody(raw);
  if (body === null) return badRequest();
  const workspaceId = await workspaceFor(ctx, body);
  const result: DecideResult =
    workspaceId === null
      ? { ok: false, reason: "unavailable" }
      : await withJev(ctx, { feature: "textDecide", workspaceId }, async (jev, refusal) => {
          if (!jev) return { ok: false, reason: refusal === "daily_cap" || refusal === "not_premium" ? "capped" : refusal === "unconfigured" ? "unavailable" : "off" };
          if (jev.remaining <= 0) return { ok: false, reason: "capped" };
          const answers = await jev.decide(decideRequest(body));
          return answers === null ? { ok: false, reason: "unavailable" } : readDecideAnswers(body, answers);
        });
  // Counts and codes only: never the transcript, a candidate's words, or a number.
  console.info(
    JSON.stringify({
      event: "texts.decide",
      style: body.style,
      candidates: body.candidates.length,
      waitingAsks: body.waitingAsks.length,
      running: body.running,
      ...(result.ok ? { act: result.act, covers: result.covers.length, stale: result.stale.length } : { reason: result.reason }),
    }),
  );
  return json(result);
}

/** `POST /agent-texts/group/engagement` `{ line, groupId, style, setBy }` → `{ ok: true }`, or `{ ok: false }` for a chat Tex has no row for. */
export async function agentTextsGroupEngagementHandler(ctx: ActionCtx, body: Record<string, unknown>): Promise<Response> {
  const line = stringField(body, "line");
  const groupId = stringField(body, "groupId");
  const setBy = stringField(body, "setBy");
  const style = body.style;
  if (line === null || groupId === null || groupId.length > MAX_CHAT || setBy === null || setBy.length > 320) return badRequest();
  if (typeof style !== "string" || !(ENGAGEMENT_STYLES as readonly string[]).includes(style)) return badRequest();
  const outcome = await ctx.runMutation(internal.functions.textGroups.setGroupEngagement, {
    groupKey: await groupKeyOf(line, groupId),
    style: style as Engagement,
    setBy,
  });
  return json(outcome === "set" ? { ok: true } : { ok: false });
}
