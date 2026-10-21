/**
 * One iMessage group chat's queue, kept in a Durable Object named after the
 * group (`sendblue-group:<group_id>`), never in any one sender's: group
 * traffic never touches a person's own 1:1 object
 * (docs/decisions/texting-assistant/groups.md).
 *
 * Tex stays quiet in a group until it is addressed: its name opening or
 * closing the message, its name in a question, or an inline reply to one of
 * Tex's own texts in this group. An untagged message is never kept, never
 * read past that test, and never sent anywhere. Tagged ones are answered one
 * at a time, in order, with no steering and no folding: two people's texts
 * are two questions.
 *
 * Every tagged message is resolved again by the control plane
 * (`/agent-texts/group`): who is in the chat (Sendblue's webhook list and
 * its members read, together, so more people can only narrow it), and the
 * one shared workspace every one of them is a member of. A turn runs with a
 * grant to that workspace alone, and its answer goes out only if nobody new
 * joined while it ran.
 *
 * What it keeps, all without text unless said:
 * - `gpending:<seq>` holds a tagged message only until it is answered or
 *   given up on.
 * - `gseen:<eventId>` a timestamp for a day, so a redelivered webhook is
 *   answered once.
 * - `gsent` the handles of Tex's last thirty texts in this group, so an
 *   inline reply to one wakes it.
 */

import { agentAnswer, post, record, ServiceError, type Fetch } from "./clients";
import { textsFromAnswer } from "./format";
import type { InboxStorage } from "./inbox";
import type { SendblueKeys } from "./sendblue";
import { reactInGroup, readGroupMembers, readOwnGroupMessage, sendGroupText, type GroupMessage } from "./sendblueGroups";

export type GroupDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  sendblue?: SendblueKeys | null;
  now: () => number;
};

type Command = { kind: "stop" } | { kind: "start" } | { kind: "use"; slug: string } | { kind: "status" };
type Pending = { message: GroupMessage; attempts: number };

const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 10;
const MAX_SENT = 30;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 20_000;
/** A group turn is asked for whole; the gateway caps it too. */
const GROUP_TURN_TIMEOUT_MS = 120_000;
const SENT_KEY = "gsent";
const seenKey = (eventId: string) => `gseen:${eventId}`;
const pendingKey = (seq: number) => `gpending:${String(seq).padStart(12, "0")}`;

/** The fixed lines, sent with no model. */
export const GROUP_LINES = {
  intro: (slug: string) =>
    `Hi, I'm Tex. Start a message with "Tex" and I'll answer here, using only @${slug}, the workspace everyone in this chat shares. ` +
    `"Tex, stop" mutes me and "Tex, start" brings me back.`,
  unknown: "I answer people who've set me up. Text me on your own to start.",
  noShared:
    "I can only use notes everyone in this chat can open, and not everyone here shares a workspace with me. Text me on your own instead.",
  choose: (slugs: string[]) =>
    `You all share ${slugs.map((slug) => `@${slug}`).join(", ")}. Which one should I use here? Say "Tex, use @${slugs[0]}".`,
  notShared: "That isn't a workspace everyone in this chat shares.",
  bound: (slug: string) => `Got it, I'll use @${slug} in this chat.`,
  status: (slug: string) => `In this chat I can see @${slug}, and only what everyone there can open.`,
  stopped: `Okay, I'll stay quiet here. Say "Tex, start" when you want me back.`,
  started: "I'm back. Start a message with \"Tex\" when you need me.",
  joined: "Someone joined while I was working on that, so I didn't send it. Ask me again.",
  sms: "I only answer in iMessage group chats.",
  failed: "I couldn't answer that one. Try again in a bit.",
} as const;

const NAME = "(?:tex|context)";
/** The name, not "Tex-Mex" or "Texas". */
const WORD = `@?${NAME}(?![\\w-])`;
/** Words a message to Tex starts with after its name, unpunctuated ("Tex what's on"), where "Tex got that wrong" is about it. */
const ASKING =
  "(?:what|what's|whats|who|who's|when|when's|where|where's|why|how|which|can|could|would|will|is|are|do|does|did|should|please|pls|" +
  "find|check|make|add|save|remember|note|tell|show|look|search|use|stop|start|write|help|list|summarize|summarise|remind|give|get|pull|read)\\b";
const OPENS = new RegExp(`^\\s*(?:(?:(?:hey|hi|yo|ok|okay)\\s+${WORD})|(?:${WORD}(?:\\s*[,:;!?.-]|\\s*$|\\s+${ASKING})))`, "i");
const CLOSES = new RegExp(`(?:^|[\\s,])${WORD}[\\s?!.]*$`, "i");
const NAMED = new RegExp(`(?:^|[^\\w-])${WORD}`, "i");
/** A reply to Tex that needs no answer. */
const NOTHING_TO_SAY = /^(?:thanks|thank you|thx|ty|ok|okay|cool|nice|lol|haha|got it|great|perfect)[\s.!]*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;

/**
 * Whether a group message is meant for Tex. Read from the words alone, with
 * no model: its name opening or closing it, its name in a question, or an
 * inline reply to Tex that says more than thanks.
 */
export function addressesTex(text: string, repliesToTex: boolean): boolean {
  const words = text.trim();
  if (words === "") return false;
  if (OPENS.test(words) || CLOSES.test(words)) return true;
  if (NAMED.test(words) && /\?\s*$/.test(words)) return true;
  return repliesToTex && !NOTHING_TO_SAY.test(words) && !EMOJI_ONLY.test(words);
}

/** The words after Tex's name, when they are one of the group commands. */
export function groupCommand(text: string): Command | null {
  const rest = text
    .trim()
    .replace(new RegExp(`^(?:(?:hey|hi|yo|ok|okay)\\s+)?${WORD}[\\s,:!.-]*`, "i"), "")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
  if (/^(?:stop|be quiet|mute|shush|shh+)$/.test(rest)) return { kind: "stop" };
  if (/^(?:start|unmute|come back)$/.test(rest)) return { kind: "start" };
  if (/^what (?:can you see|do you see|can you read)(?: here)?\??$/.test(rest)) return { kind: "status" };
  const use = /^use @?([a-z0-9][a-z0-9-]{0,63})$/.exec(rest);
  return use ? { kind: "use", slug: use[1] } : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The people in the chat, without Tex's own line, in one order. */
export function peopleOf(line: string, ...lists: (readonly string[] | null)[]): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []).filter((entry) => entry !== line))].sort();
}

/**
 * Accept a group message: answered later by the alarm when it is meant for
 * Tex, dropped right here when it is not. Untagged words are never stored.
 */
export async function acceptGroup(storage: InboxStorage, message: GroupMessage, now: number): Promise<"queued" | "ignored" | "duplicate" | "full"> {
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  const repliesToTex = message.replyTo !== undefined && sent.includes(message.replyTo);
  if (!addressesTex(message.text, repliesToTex)) return "ignored";
  if ((await storage.get<number>(seenKey(message.eventId))) !== undefined) return "duplicate";
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  if (pending.size >= MAX_PENDING) return "full";
  const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
  await storage.put("gseq", seq);
  await storage.put(seenKey(message.eventId), now);
  // Whether it replies to Tex is decided now, against the handles Tex sent; the turn reads the words it quotes.
  await storage.put<Pending>(pendingKey(seq), { message: repliesToTex ? message : { ...message, replyTo: undefined }, attempts: 0 });
  await storage.setAlarm(now);
  return "queued";
}

/** Answer every tagged message waiting, oldest first. Called from the alarm. */
export async function drainGroup(storage: InboxStorage, deps: GroupDeps): Promise<void> {
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  for (const [key, item] of pending) {
    try {
      await answerGroup(storage, item.message, deps);
      await storage.delete(key);
    } catch (error) {
      const attempts = item.attempts + 1;
      log("failed", error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "error");
      if (attempts < MAX_ATTEMPTS) {
        await storage.put<Pending>(key, { ...item, attempts });
        await storage.setAlarm(deps.now() + RETRY_MS);
        return;
      }
      await storage.delete(key);
      await say(storage, deps, item.message, GROUP_LINES.failed).catch(() => {});
    }
  }
  await pruneSeen(storage, deps.now());
}

async function answerGroup(storage: InboxStorage, message: GroupMessage, deps: GroupDeps): Promise<void> {
  if (!deps.sendblue) throw new ServiceError("sendblue", null);
  // A green-bubble group is never answered from anyone's notes: SMS vouches for no sender.
  if (message.sms) return void (await say(storage, deps, message, GROUP_LINES.sms));
  const chat = { line: message.line, groupId: message.groupId };
  const command = groupCommand(message.text);

  // Sendblue's own list too: more people only ever narrows what Tex may use.
  const members = await readGroupMembers(deps.fetch, deps.sendblue, message.groupId);
  if (members === null) log("members_unread");
  const people = peopleOf(message.line, message.participants, members);
  const asked = await askControlPlane(deps, message, people, command);
  const status = asked.status;
  if (status === "refused" || status === "muted") return log(status);
  // The same tapback for every tagger, linked or not, so it says nothing about who they are.
  if (command === null) await reactInGroup(deps.fetch, deps.sendblue, chat, message.messageId, "👀");
  if (status === "unknown_sender") return asked.tell === true ? void (await say(storage, deps, message, GROUP_LINES.unknown)) : log(status);
  if (status === "no_shared") return void (await say(storage, deps, message, GROUP_LINES.noShared));
  if (status === "not_shared") return void (await say(storage, deps, message, GROUP_LINES.notShared));
  if (status === "stopped") return void (await say(storage, deps, message, GROUP_LINES.stopped));
  if (status === "started") return void (await say(storage, deps, message, GROUP_LINES.started));
  if (status === "choose") return void (await say(storage, deps, message, GROUP_LINES.choose(asked.slugs)));
  if (status !== "ready") throw new ServiceError("control_plane", null);
  if (command?.kind === "use") return void (await say(storage, deps, message, GROUP_LINES.bound(asked.slug)));
  if (command?.kind === "status") return void (await say(storage, deps, message, GROUP_LINES.status(asked.slug)));
  if (asked.accessToken === undefined) throw new ServiceError("control_plane", null);
  if (asked.intro) await say(storage, deps, message, GROUP_LINES.intro(asked.slug), false);

  const quoted = message.replyTo === undefined ? null : await readOwnGroupMessage(deps.fetch, deps.sendblue, message.replyTo, chat);
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await sha256Hex(people.join(",")),
    ...(asked.handle ? { from: asked.handle } : {}),
  };
  let result: { status: number; json: unknown };
  try {
    result = await post(
      deps.fetch,
      "gateway",
      `${deps.gatewayOrigin}/agent`,
      asked.accessToken,
      {
        question: message.text,
        group,
        ...(asked.timeZone ? { timeZone: asked.timeZone } : {}),
        ...(quoted !== null ? { quoted } : message.replyTo !== undefined ? { replied: true } : {}),
      },
      GROUP_TURN_TIMEOUT_MS,
    );
  } catch {
    throw new ServiceError("gateway", null);
  }
  const answer = agentAnswer(result.status, result.json);
  if (answer.kind === "daily_limit") return void (await say(storage, deps, message, "That's all the questions for today. Ask me again tomorrow."));
  if (answer.kind === "no_model") return void (await say(storage, deps, message, "I can't answer from here yet."));
  if (answer.kind !== "answer") throw new ServiceError("gateway", result.status);

  // Sent only to the people it was written for: someone who joined meanwhile was never part of its scope.
  //
  // A list that could not be read is not a list with nobody new in it. On the
  // way in, falling back to the webhook's own names is safe because more names
  // only ever narrow the workspace the chat may use; here the fallback would
  // run the other way, and this is the only thing standing between an answer
  // drawn from the bound workspace and somebody who is not a member of it. So
  // an unreadable list holds the answer, as a joiner does.
  const now = await readGroupMembers(deps.fetch, deps.sendblue, message.groupId);
  if (now === null) {
    log("members_unread_after");
    return void (await say(storage, deps, message, GROUP_LINES.failed));
  }
  const joined = now.some((phone) => phone !== message.line && !people.includes(phone));
  if (joined) return void (await say(storage, deps, message, GROUP_LINES.joined));
  const texts = textsFromAnswer(answer.text);
  for (const [i, text] of texts.entries()) await say(storage, deps, message, text, i === 0);
  log("answered");
}

type ControlAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" | "not_shared" }
  | { status: "unknown_sender"; tell?: boolean }
  | { status: "choose"; slugs: string[] }
  | { status: "ready"; slug: string; intro: boolean; timeZone?: string; handle?: string; accessToken?: string };

async function askControlPlane(deps: GroupDeps, message: GroupMessage, people: string[], command: Command | null): Promise<ControlAnswer> {
  const wire = command === null || command.kind === "status" ? undefined : command;
  const { status, json } = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/group`, deps.workerSecret, {
    line: message.line,
    groupId: message.groupId,
    sender: message.from,
    participants: people.includes(message.from) ? people : [...people, message.from],
    ...(wire !== undefined ? { command: wire } : {}),
    ...(command === null ? { mint: true } : {}),
  });
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  const slug = (value: unknown) => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,64}$/.test(value);
  switch (body.status) {
    case "refused":
    case "muted":
    case "stopped":
    case "started":
    case "no_shared":
    case "not_shared":
      return { status: body.status };
    case "unknown_sender":
      return { status: "unknown_sender", tell: body.tell === true };
    case "choose": {
      const slugs = Array.isArray(body.slugs) ? body.slugs.filter(slug) : [];
      if (slugs.length === 0) throw new ServiceError("control_plane", status);
      return { status: "choose", slugs: slugs as string[] };
    }
    case "ready":
      if (!slug(body.slug)) throw new ServiceError("control_plane", status);
      return {
        status: "ready",
        slug: body.slug as string,
        intro: body.intro === true,
        ...(typeof body.timeZone === "string" && /^[A-Za-z0-9_+\-/]{1,64}$/.test(body.timeZone) ? { timeZone: body.timeZone } : {}),
        ...(slug(body.handle) ? { handle: body.handle as string } : {}),
        ...(typeof body.accessToken === "string" && body.accessToken !== "" ? { accessToken: body.accessToken } : {}),
      };
    default:
      throw new ServiceError("control_plane", status);
  }
}

/** One text into the group, threaded under the message it answers, remembered so a reply to it wakes Tex. */
async function say(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, text: string, threaded = true): Promise<void> {
  if (!deps.sendblue) throw new ServiceError("sendblue", null);
  const handle = await sendGroupText(deps.fetch, deps.sendblue, { line: message.line, groupId: message.groupId }, text, threaded ? message.messageId : undefined);
  if (handle === undefined) return;
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  await storage.put(SENT_KEY, [...sent.filter((entry) => entry !== handle), handle].slice(-MAX_SENT));
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "gseen:" });
  for (const [key, at] of seen) if (now - at > SEEN_FOR_MS) await storage.delete(key);
}

/** One line per outcome, never a number, a name or the words. */
function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}) }));
}
