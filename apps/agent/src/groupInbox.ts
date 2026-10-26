/**
 * One iMessage group chat's queue, kept in a Durable Object named after the
 * group (`sendblue-group:<group_id>`), never in any one sender's: group
 * traffic never touches a person's own 1:1 object
 * (docs/decisions/texting-assistant/groups.md).
 *
 * Tex stays quiet in a group until it is addressed: its name opening or
 * closing the message, its name in a question, or an inline reply to one of
 * Tex's own texts in this group. An untagged message is never answered; while
 * the chat is bound it is kept until the next tag hands it over as what the
 * chat said (`groupChat.ts`). Tagged ones are answered one at a time, in
 * order, with no steering and no folding: two people's texts are two
 * questions.
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
 * - `gseen:<eventId>:<hash>` a timestamp for a day, so a redelivered webhook
 *   is answered once; keyed by the words' hash too, so an edit Sendblue
 *   delivers under the same handle is read as the new message it is.
 * - `grecent` hashes of who tagged what in the last ten minutes, so the same
 *   ask sent twice is answered once (the group chat of 2026-10-21).
 * - `gask` who Tex last asked for a yes, for half an hour, never the words:
 *   their bare "yes" or "send" is then for Tex, not chat.
 * - `gsent` the handles of Tex's last thirty texts in this group, so an
 *   inline reply to one wakes it.
 * - `gchat:<seq>` what the chat said since Tex last answered, with text,
 *   only while it is bound (`groupChat.ts`).
 */

import { askAgentStream, post, record, ServiceError, type Fetch } from "./clients";
import { PICTURE_FAILED, shrinkPicture, type OutgoingPicture } from "./outgoing";
import type { Picture } from "./line";
import { prepareAttachments, type ImagesLike } from "./attachments";
import { MAX_INBOUND_ATTACHMENTS, type InboundAttachment } from "./inbound";
import { textsWithExact } from "./format";
import { tapbackText, type Reaction } from "./reactions";
import { ackEmoji } from "./ackEmoji";
import { dropThumb, dueThumb, GROUP_THUMB_KEY, holdThumb } from "./thumbs";
import type { InboxStorage } from "./inbox";
import type { SendblueKeys } from "./sendblue";
import { chatBefore, dropChatLines, keepChatLine, peopleOf, setChatBound, sha256Hex } from "./groupChat";
import { reactInGroup, readGroupMembers, readOwnGroupMessage, sendGroupMedia, sendGroupText, type GroupMessage } from "./sendblueGroups";
import { watchConversation } from "./reviewWatch";
import { chatJobs, noteJobSent, noteJobUpdate, startJobs, steerJobs, type JobRun, type JobSteer, type JobUpdate } from "./jobs";

export type GroupDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  sendblue?: SendblueKeys | null;
  /** Converts a photo the model cannot read (`attachments.ts`); absent, it is described instead. */
  images?: ImagesLike;
  /** Serves a picture Tex sends at a short-lived address Sendblue fetches (`media.ts`); absent, pictures aren't sent. */
  hostPicture?: (picture: Picture) => Promise<string>;
  now: () => number;
  /** Starts a background job in an object of its own (`jobs.ts`); absent, the chat's turns are offered none. */
  spawnJob?: (id: string, run: JobRun) => Promise<void>;
  /** Hands a later text to a running job's object; true when it took it (`jobRun.ts`). */
  steerJob?: (id: string, steer: JobSteer) => Promise<boolean>;
};

/** A group's queue is named apart from every phone's, which always starts with "+". */
export function groupInboxName(groupId: string): string {
  return `sendblue-group:${groupId}`;
}

type Command = { kind: "stop" } | { kind: "start" } | { kind: "use"; slug: string } | { kind: "status" };
/** `at`: when it was accepted, so its turn is handed only what the chat said before it. */
type Pending = { message: GroupMessage; attempts: number; at?: number };

const SEEN_FOR_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 10;
const MAX_SENT = 30;
const MAX_ATTEMPTS = 3;
const RETRY_MS = 20_000;
const SENT_KEY = "gsent";
/** The workspace names Tex last asked this chat to pick from, never text: a bare "supa" then answers it. */
const CHOICE_KEY = "gchoice";
const CHOICE_FOR_MS = 24 * 60 * 60 * 1000;
type Choice = { slugs: string[]; at: number };
const seenKey = (eventId: string, words: string) => `gseen:${eventId}:${words}`;
/** The same person tagging Tex with the same words this soon after is the same ask. */
export const SAME_ASK_MS = 10 * 60_000;
const RECENT_KEY = "grecent";
type Recent = { h: string; at: number };
/**
 * How long a tag waits before it is answered, so a picture sent just after it
 * ("Tex, file this screenshot", then the screenshot) is read with it, as a
 * 1:1 text's words wait for one (`inbox.ts` `TEXT_WAIT_MS`).
 */
export const GROUP_TEXT_WAIT_MS = 4_000;
/** A picture from the person whose tag is still waiting joins that tag, this soon after it. */
export const PICTURE_JOINS_MS = 2 * 60_000;
/** The newest pictures and files a turn reads, its own and the chat's since Tex last answered. */
export const MAX_GROUP_FILES = 4;
/** How a picture sent without words reads in the chat Tex is handed. */
export const PICTURE_LINE = "(sent a picture or file)";
/** How long a yes Tex asked for stays the asker's to give without its name. */
export const ASK_OPEN_MS = 30 * 60_000;
const ASK_KEY = "gask";
type OpenAsk = { from: string; at: number };
/** Words that only answer a yes Tex asked for: a yes, a no, or "send it" (`apps/mcp/src/agent/textedApprovals.js` decides what they settle). A bare "ok" stays chat: it is not a yes to a send there, and would only disarm the ask. */
const ANSWERS_ASK =
  /^\s*(?:yes|yes please|yep|yeah|yup|y|no|nope|cancel|send|send it|send that|file it|do it|go ahead|looks good)(?:[\s,.!-]+(?:send it|send|please|file it|do it|go ahead))*\s*[.!]*\s*$/i;
const pendingKey = (seq: number) => `gpending:${String(seq).padStart(12, "0")}`;

/** The fixed lines, sent with no model. */
export const GROUP_LINES = {
  intro: (slug: string) =>
    `Hi, I'm Tex. Start a message with "Tex" and I'll answer here, using only @${slug}, the workspace everyone in this chat shares. ` +
    `I follow the chat so you can just say "Tex, write this up", and keep it in @${slug}. "Tex, stop" mutes me and "Tex, start" brings me back.`,
  unknown: "I answer people who've set me up. Text me on your own to start.",
  noShared:
    "I can only use notes everyone in this chat can open, and not everyone here shares a workspace with me. Text me on your own instead.",
  choose: (slugs: string[]) =>
    `You all share ${slugs.map((slug) => `@${slug}`).join(" and ")}. Which one should I use here? Just say its name.`,
  notShared: (slugs: string[]) =>
    "That isn't a workspace everyone in this chat shares." +
    (slugs.length > 0 ? ` You all share ${slugs.map((slug) => `@${slug}`).join(", ")}. Say "Tex use @${slugs[0]}" to pick one.` : ""),
  bound: (slug: string, intro = false) =>
    `Got it, I'll use @${slug} in this chat.` +
    (intro
      ? ` Start a message with "Tex" when you need me. I follow the chat so you can just say "Tex, write this up", and keep it in @${slug}. ` +
        `"Tex, stop" mutes me and "Tex, start" brings me back.`
      : ""),
  status: (slug: string) => `In this chat I can see @${slug}, and only what everyone there can open.`,
  // Guest mode (`docs/decisions/texting-assistant/group-guests.md`): people here who aren't on Context are guests.
  guestBound: (slug: string, guest: GuestInfo) =>
    `Got it. Everyone here is a guest of @${slug} now, as the group @${guest.group}. I only see notes shared with that group, ` +
    `and I keep what I make for this chat in ${guest.folder}. Anyone here can start a message with "Tex" to ask me something. "Tex, stop" mutes me.`,
  guestIntro: (slug: string, guest: GuestInfo) =>
    `Hi, I'm Tex. Anyone here can start a message with "Tex" and I'll answer, using only notes shared with @${guest.group} in @${slug}. ` +
    `I keep what I make in ${guest.folder}. "Tex, stop" mutes me and "Tex, start" brings me back.`,
  guestStatus: (slug: string, guest: GuestInfo) => `In this chat I can see only notes shared with @${guest.group} in @${slug}.`,
  notAllowed: (slug: string) => `Only an owner or editor of @${slug} can bring it into this chat. One of them can say "Tex use @${slug}".`,
  guestsOff:
    "The person who brought me into this chat can't share that workspace here anymore, so I'm stepping back. " +
    'An owner or editor can say "Tex use @name" to start again.',
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
/** "Tex ^ do this", "Tex ↑": the message above is the ask. */
const POINTS_UP = "(?:\\^+|↑|⬆️?|☝️?|👆)";
/*
  Any other word after the name is an ask too ("Tex turn this guy into a cat",
  2026-10-23, went unanswered because "turn" was not on the list above),
  unless it reads as talking about Tex: a past or third-person verb, or a word
  people use about it ("Tex got that wrong lol", "Tex was down", "Tex sucks").
*/
const ABOUT = "(?:was|were|got|gets|has|had|have|said|says|just|keeps|kept|always|never|really|seems|thinks|lol|lmao|haha|too|again|isn't|wasn't|can't|won't|didn't|doesn't|[a-z]+ed|[a-z]+s)\\b";
const OPENS = new RegExp(
  `^\\s*(?:(?:(?:hey|hi|yo|ok|okay)\\s+${WORD})|(?:${WORD}(?:\\s*[,:;!?.-]|\\s*$|\\s*${POINTS_UP}|\\s+${ASKING}|\\s+(?!${ABOUT})[a-z])))`,
  "i",
);
const CLOSES = new RegExp(`(?:^|[\\s,])${WORD}[\\s?!.]*$`, "i");
const NAMED = new RegExp(`(?:^|[^\\w-])${WORD}`, "i");
/** A reply to Tex that needs no answer. */
const NOTHING_TO_SAY = /^(?:thanks|thank you|thx|ty|ok|okay|cool|nice|lol|haha|got it|great|perfect)[\s.!]*$/i;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;
/** A workspace slug on its own, with or without its `@`. */
const BARE_NAME = /^@?([a-z0-9][a-z0-9-]{0,63})$/;

/**
 * Whether a group message is meant for Tex. Read from the words alone, with
 * no model: its name opening or closing it, its name in a question, or an
 * inline reply to Tex that says more than thanks.
 */
export function addressesTex(text: string, repliesToTex: boolean): boolean {
  const words = unquoted(text);
  if (words === "") return false;
  if (OPENS.test(words) || CLOSES.test(words)) return true;
  if (NAMED.test(words) && /\?\s*$/.test(words)) return true;
  return repliesToTex && !NOTHING_TO_SAY.test(words) && !EMOJI_ONLY.test(words);
}

/** The words without the quotes a person may type around them ("“Tex use @supa”"). */
function unquoted(text: string): string {
  return text.trim().replace(/^["“”'‘’`]+/, "").replace(/["“”'‘’`]+$/, "").trim();
}

/**
 * The words after Tex's name, when they are one of the group commands. While
 * the chat is picking a workspace (`choices`), one of the names it was offered
 * on its own ("supa", "@supa", "Tex supa") picks it.
 *
 * Tex's name is optional here because the caller has already decided the
 * message is for Tex (`acceptGroup`). An unaddressed message reaches this
 * only through `offeredName` below, which is narrower on purpose.
 */
export function groupCommand(text: string, choices: readonly string[] = []): Command | null {
  const rest = unquoted(text)
    .replace(new RegExp(`^(?:(?:hey|hi|yo|ok|okay)\\s+)?${WORD}[\\s,:!.-]*`, "i"), "")
    .trim()
    .replace(/[.!]+$/, "")
    .toLowerCase();
  if (/^(?:stop|be quiet|mute|shush|shh+)$/.test(rest)) return { kind: "stop" };
  if (/^(?:start|unmute|come back)$/.test(rest)) return { kind: "start" };
  if (/^what (?:can you see|do you see|can you read)(?: here)?\??$/.test(rest)) return { kind: "status" };
  const use = /^use @?([a-z0-9][a-z0-9-]{0,63})$/.exec(rest);
  if (use) return { kind: "use", slug: use[1] };
  const named = BARE_NAME.exec(rest);
  return named && choices.includes(named[1]) ? { kind: "use", slug: named[1] } : null;
}

/**
 * One of the names Tex just offered, said on its own — the only words it
 * answers without being addressed, and only while that question is open.
 *
 * `groupCommand` takes Tex's name as optional, which is right once a message
 * is known to be for Tex and wrong as the way in: it would make a bare "stop"
 * or "start" from a conversation between two other people mute or unmute Tex.
 * Those words are chat, and chat is what `keepChatLine` is for.
 */
export function offeredName(text: string, choices: readonly string[]): string | null {
  if (choices.length === 0) return null;
  const named = BARE_NAME.exec(unquoted(text).replace(/[.!]+$/, "").trim().toLowerCase());
  return named !== null && choices.includes(named[1]) ? named[1] : null;
}

export { peopleOf };

/**
 * Accept a group message: answered later by the alarm when it is meant for
 * Tex; otherwise kept as what the chat said while the chat is bound, and
 * dropped right here while it is not.
 */
export async function acceptGroup(storage: InboxStorage, message: GroupMessage, now: number): Promise<"queued" | "kept" | "ignored" | "duplicate" | "full"> {
  if (message.reaction !== undefined) return await acceptThumb(storage, message, message.reaction, now);
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  const repliesToTex = message.replyTo !== undefined && sent.includes(message.replyTo);
  const tagged =
    addressesTex(message.text, repliesToTex) ||
    offeredName(message.text, await openChoice(storage, now)) !== null ||
    (await answersOpenAsk(storage, message, now));
  const seen = seenKey(message.eventId, await sha256Hex(message.text));
  if ((await storage.get<number>(seen)) !== undefined) return tagged ? "duplicate" : "ignored";
  if (!tagged) {
    if (await joinsWaitingTag(storage, message, now)) {
      await storage.put(seen, now);
      return "queued";
    }
    if (!(await keepChatLine(storage, message, now))) return "ignored";
    await storage.put(seen, now);
    return "kept";
  }
  if (await askedJustNow(storage, message, now)) {
    await storage.put(seen, now);
    return "duplicate";
  }
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  if (pending.size >= MAX_PENDING) return "full";
  const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
  await storage.put("gseq", seq);
  await storage.put(seen, now);
  // Whether it replies to Tex is decided now, against the handles Tex sent; the turn reads the words it quotes.
  await storage.put<Pending>(pendingKey(seq), { message: repliesToTex ? message : { ...message, replyTo: undefined }, attempts: 0, at: now });
  // Words alone wait a moment for a picture to follow them; a tag that brought one goes now.
  await storage.setAlarm(message.attachments?.length ? now : now + GROUP_TEXT_WAIT_MS);
  return "queued";
}

/**
 * A picture sent without words by someone whose tag is still waiting to be
 * answered joins that tag (Jhon, 2026-10-23: "Tex, file this screenshot as a
 * bug report first", then the screenshot, and Tex answered that it couldn't
 * see one). Only their own tag, and only one sent a moment ago.
 */
async function joinsWaitingTag(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  if (message.text !== "" || !message.attachments?.length) return false;
  const pending = [...(await storage.list<Pending>({ prefix: "gpending:" }))].reverse();
  const waiting = pending.find(([, item]) => item.message.from === message.from && item.attempts === 0 && now - (item.at ?? 0) < PICTURE_JOINS_MS);
  if (waiting === undefined) return false;
  const [key, item] = waiting;
  const attachments = [...(item.message.attachments ?? []), ...message.attachments].slice(0, MAX_INBOUND_ATTACHMENTS);
  await storage.put<Pending>(key, { ...item, message: { ...item.message, attachments } });
  return true;
}

/** The pictures and files a turn reads: the newest of its own and of what the chat sent since Tex last answered, oldest first. */
export function filesFor(message: GroupMessage, lines: readonly { attachments?: InboundAttachment[] }[]): InboundAttachment[] {
  const all = [...lines.flatMap((line) => line.attachments ?? []), ...(message.attachments ?? [])];
  return all.slice(-MAX_GROUP_FILES);
}

/**
 * A like on Tex's ask from the person it asked, which goes at once as their
 * yes (`thumbs.ts`). Anyone else's is ignored:
 * only the asker's yes can release what was held for them.
 */
async function acceptThumb(storage: InboxStorage, message: GroupMessage, reaction: Reaction, now: number): Promise<"queued" | "ignored"> {
  const ask = await storage.get<OpenAsk>(ASK_KEY);
  if (ask === undefined || now - ask.at >= ASK_OPEN_MS || ask.from !== (await sha256Hex(message.from))) return "ignored";
  if (reaction.removed) {
    await dropThumb(storage, reaction.words, GROUP_THUMB_KEY);
    return "ignored";
  }
  await holdThumb<GroupMessage>(storage, { ...message, text: tapbackText(reaction.how) }, reaction.words, now, GROUP_THUMB_KEY);
  return "queued";
}

/**
 * Whether this person tagged Tex with these same words a moment ago (Jhon,
 * 2026-10-21: the same bug report sent twice was written up twice). Kept as
 * hashes of sender and words, never either. Remembers this ask either way.
 */
async function askedJustNow(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  const h = await sha256Hex(`${message.from}\n${message.text.replace(/\s+/g, " ").trim().toLowerCase()}`);
  const recent = ((await storage.get<Recent[]>(RECENT_KEY)) ?? []).filter((item) => now - item.at < SAME_ASK_MS);
  const again = recent.some((item) => item.h === h);
  await storage.put<Recent[]>(RECENT_KEY, [...recent.filter((item) => item.h !== h), { h, at: now }].slice(-MAX_SENT));
  return again;
}

/**
 * A bare yes, no or "send" from the person Tex just asked, while that ask is
 * open (Jhon's "yes" to the bug report, 2026-10-21, kept as chat). Anyone
 * else's is chat: only the asker's yes can release what was held for them.
 */
async function answersOpenAsk(storage: InboxStorage, message: GroupMessage, now: number): Promise<boolean> {
  if (!ANSWERS_ASK.test(unquoted(message.text))) return false;
  const ask = await storage.get<OpenAsk>(ASK_KEY);
  return ask !== undefined && now - ask.at < ASK_OPEN_MS && ask.from === (await sha256Hex(message.from));
}

/** Answer every tagged message waiting, oldest first. Called from the alarm. */
export async function drainGroup(storage: InboxStorage, deps: GroupDeps): Promise<void> {
  // A 👍 on the ask joins the queue as the asker's answer.
  const thumb = await dueThumb<GroupMessage>(storage, deps.now(), GROUP_THUMB_KEY);
  if (thumb !== undefined) {
    const seq = ((await storage.get<number>("gseq")) ?? 0) + 1;
    await storage.put("gseq", seq);
    await storage.put<Pending>(pendingKey(seq), { message: thumb, attempts: 0, at: deps.now() });
  }
  const pending = await storage.list<Pending>({ prefix: "gpending:" });
  for (const [key, item] of pending) {
    try {
      await answerGroup(storage, item.message, item.at ?? deps.now(), deps);
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

async function answerGroup(storage: InboxStorage, message: GroupMessage, acceptedAt: number, deps: GroupDeps): Promise<void> {
  if (!deps.sendblue) throw new ServiceError("sendblue", null);
  // A green-bubble group is never answered from anyone's notes: SMS vouches for no sender.
  if (message.sms) return void (await say(storage, deps, message, GROUP_LINES.sms));
  const chat = { line: message.line, groupId: message.groupId };
  const command = groupCommand(message.text, await openChoice(storage, deps.now()));

  // Sendblue's own list too: more people only ever narrows what Tex may use.
  const members = await readGroupMembers(deps.fetch, deps.sendblue, message.groupId);
  if (members === null) log("members_unread");
  const people = peopleOf(message.line, message.participants, members);
  const asked = await askControlPlane(deps, message, people, command);
  const status = asked.status;
  // A chat that isn't answering keeps nothing it was told.
  if (status === "muted" || status === "stopped" || status === "no_shared") await setChatBound(storage, null);
  if (status === "refused" || status === "muted") return log(status);
  // Read from the words alone, the same for every tagger linked or not, so it says nothing about who they are (`ackEmoji.ts`).
  if (command === null && message.reaction === undefined) await reactInGroup(deps.fetch, deps.sendblue, chat, message.messageId, ackEmoji(message.text));
  if (status === "unknown_sender") return asked.tell === true ? void (await say(storage, deps, message, GROUP_LINES.unknown)) : log(status);
  if (status === "no_shared") return void (await say(storage, deps, message, GROUP_LINES.noShared));
  if (status === "not_shared") return void (await say(storage, deps, message, GROUP_LINES.notShared(asked.slugs)));
  if (status === "not_allowed") return void (await say(storage, deps, message, GROUP_LINES.notAllowed(asked.slug)));
  if (status === "guests_off") return void (await say(storage, deps, message, GROUP_LINES.guestsOff));
  if (status === "stopped") return void (await say(storage, deps, message, GROUP_LINES.stopped));
  if (status === "started") return void (await say(storage, deps, message, GROUP_LINES.started));
  if (status === "choose") {
    await storage.put<Choice>(CHOICE_KEY, { slugs: asked.slugs, at: deps.now() });
    return void (await say(storage, deps, message, GROUP_LINES.choose(asked.slugs)));
  }
  if (status !== "ready") throw new ServiceError("control_plane", null);
  await storage.delete(CHOICE_KEY);
  await setChatBound(storage, message);
  const guest = asked.guest;
  if (command?.kind === "use") {
    return void (await say(storage, deps, message, guest ? GROUP_LINES.guestBound(asked.slug, guest) : GROUP_LINES.bound(asked.slug, asked.intro)));
  }
  if (command?.kind === "status") return void (await say(storage, deps, message, guest ? GROUP_LINES.guestStatus(asked.slug, guest) : GROUP_LINES.status(asked.slug)));
  if (asked.accessToken === undefined) throw new ServiceError("control_plane", null);
  if (asked.intro) await say(storage, deps, message, guest ? GROUP_LINES.guestIntro(asked.slug, guest) : GROUP_LINES.intro(asked.slug));

  const quoted = message.replyTo === undefined ? null : await readOwnGroupMessage(deps.fetch, deps.sendblue, message.replyTo, chat);
  const said = await chatBefore(storage, message, acceptedAt, deps.now());
  const handles = new Map((asked.names ?? []).map(({ phone, handle }) => [phone, handle]));
  // A guest is named in the chat's lines by a label from the control plane, never by number; never offered an email.
  const labels = new Map((asked.guests ?? []).map(({ phone, label }) => [phone, label]));
  // Pictures sent in the chat are read, as a 1:1 text's are (the group chat of 2026-10-23).
  const files = filesFor(message, said.lines);
  const attachments = files.length > 0 ? await prepareAttachments(files, { fetch: deps.fetch, images: deps.images }) : [];
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await sha256Hex(people.join(",")),
    ...(asked.handle ? { from: asked.handle } : {}),
    // Who is here, by handle, so an email can be offered to one of them to send (`apps/mcp/src/tools/offerFor.js`).
    people: [...new Set(handles.values())].filter(Boolean),
    ...(guest ? { guest } : {}),
  };
  /*
    Asked for as a stream, as a person's own text is (the owner, 2026-10-23:
    "group Tex should literally be the same exact as DM Tex"): a long ask
    texts its progress into the chat while it works, each line only while
    nobody new has joined, the same check the answer gets below.
  */
  const progress = async (text: string) => {
    const now = await readGroupMembers(deps.fetch, deps.sendblue!, message.groupId);
    if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) return;
    await say(storage, deps, message, text);
  };
  const answer = await askAgentStream(
    deps.fetch,
    deps.gatewayOrigin,
    asked.accessToken,
    {
      question: message.text,
      group: { ...group, chat: said.lines.map((line) => ({ from: handles.get(line.from) ?? labels.get(line.from) ?? "", text: line.text || PICTURE_LINE })) },
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(asked.timeZone ? { timeZone: asked.timeZone } : {}),
      ...(deps.spawnJob ? { running: await chatJobs(storage, deps.now()) } : {}),
      ...(message.reaction !== undefined
        ? { quoted: message.reaction.words, tapback: message.reaction.how }
        : quoted !== null
          ? { quoted }
          : message.replyTo !== undefined
            ? { replied: true }
            : {}),
    },
    progress,
  );
  if (answer.kind === "daily_limit") return void (await say(storage, deps, message, "That's all the questions for today. Ask me again tomorrow."));
  if (answer.kind === "no_model") return void (await say(storage, deps, message, "I can't answer from here yet."));
  if (answer.kind !== "answer") throw new ServiceError("gateway", null);
  // Filed in the chat's memory by that turn: this object's copy goes.
  await dropChatLines(storage, said.keys);
  // An answer that asks for a yes leaves it open for the one person it asks: the
  // asker, or the person an email is offered to (`askFor`); any other answer closes it.
  const asks = answer.askFor !== undefined ? [...handles].find(([, handle]) => handle === answer.askFor)?.[0] : message.from;
  if ((answer.verbatim?.length ?? 0) > 0 && asks !== undefined) await storage.put<OpenAsk>(ASK_KEY, { from: await sha256Hex(asks), at: deps.now() });
  else await storage.delete(ASK_KEY);

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
  const texts = textsWithExact(answer.text, answer.verbatim);
  // Every bubble under the message it answers, not only the first (Jhon's bug report, 2026-10-21).
  for (const text of texts) await say(storage, deps, message, text);
  // A picture Tex drew, made or sent from a note, after the words, as in a 1:1 text.
  for (const picture of answer.pictures) await sendPicture(storage, deps, message, picture);
  log("answered");
  // Twenty quiet minutes from now, this conversation is scored (`reviewWatch.ts`).
  await watchConversation(storage, { kind: "group", message, people }, deps.now());
  // Long asks it handed off run beside the chat (`jobs.ts`), each re-checking who is here when it answers.
  if (answer.jobs && deps.spawnJob) {
    await startJobs(storage, answer.jobs, {
      now: deps.now(),
      inbox: groupInboxName(message.groupId),
      origin: { kind: "group", message, at: acceptedAt },
      place: { line: message.line, groupId: message.groupId, messageId: message.messageId },
      spawn: deps.spawnJob,
    });
  }
  // A change to a job still running is handed to it, in the words of whoever texted it.
  if (answer.steers && deps.steerJob) await steerJobs(storage, answer.steers, { id: message.eventId, text: message.text }, deps.steerJob, deps.now());
}

/** A background job's word (`jobRun.ts`): its status kept, its texts sent under the message it answers. */
export async function groupJobUpdate(storage: InboxStorage, deps: GroupDeps, update: JobUpdate): Promise<boolean> {
  const entry = await noteJobUpdate(storage, update, deps.now());
  if (entry === null || entry.quiet || entry.line === undefined || entry.groupId === undefined || entry.messageId === undefined) return entry !== null;
  const where = { line: entry.line, groupId: entry.groupId, messageId: entry.messageId };
  for (const [i, text] of (update.texts ?? []).entries()) {
    const index = (update.first ?? 0) + i;
    if (index < (entry.sent ?? 0)) continue;
    await say(storage, deps, where, text);
    await noteJobSent(storage, update.id, index + 1);
  }
  return true;
}

export type ControlAnswer =
  | { status: "refused" | "muted" | "stopped" | "started" | "no_shared" }
  | { status: "not_shared"; slugs: string[] }
  | { status: "not_allowed"; slug: string }
  | { status: "guests_off" }
  | { status: "unknown_sender"; tell?: boolean }
  | { status: "choose"; slugs: string[] }
  | {
      status: "ready";
      slug: string;
      intro: boolean;
      timeZone?: string;
      handle?: string;
      accessToken?: string;
      names?: { phone: string; handle: string }[];
      guest?: GuestInfo;
      guests?: { phone: string; label: string }[];
    };

/** A guest chat's group, three words and folder (`apps/convex/functions/lib/textGroupGuests.ts`). */
export type GuestInfo = { group: string; words: string; folder: string };

const LABEL = /^guest-[0-9a-f]{4}$/;
const WORDS = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;

function guestInfoOf(value: unknown): GuestInfo | undefined {
  const info = record(value);
  if (typeof info.group !== "string" || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(info.group)) return undefined;
  if (typeof info.words !== "string" || !WORDS.test(info.words) || typeof info.folder !== "string") return undefined;
  return { group: info.group, words: info.words, folder: info.folder };
}

export async function askControlPlane(deps: GroupDeps, message: GroupMessage, people: string[], command: Command | null): Promise<ControlAnswer> {
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
      return { status: body.status };
    case "not_shared":
      return { status: "not_shared", slugs: (Array.isArray(body.slugs) ? body.slugs.filter(slug) : []).slice(0, 8) as string[] };
    case "unknown_sender":
      return { status: "unknown_sender", tell: body.tell === true };
    case "not_allowed":
      if (!slug(body.slug)) throw new ServiceError("control_plane", status);
      return { status: "not_allowed", slug: body.slug as string };
    case "guests_off":
      return { status: "guests_off" };
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
        names: (Array.isArray(body.names) ? body.names : []).map(record).flatMap((entry) =>
          typeof entry.phone === "string" && slug(entry.handle) ? [{ phone: entry.phone, handle: entry.handle as string }] : [],
        ),
        ...(guestInfoOf(body.guest) ? { guest: guestInfoOf(body.guest) } : {}),
        guests: (Array.isArray(body.guests) ? body.guests : []).map(record).flatMap((entry) =>
          typeof entry.phone === "string" && typeof entry.label === "string" && LABEL.test(entry.label) ? [{ phone: entry.phone, label: entry.label }] : [],
        ),
      };
    default:
      throw new ServiceError("control_plane", status);
  }
}

/** One text into the group, threaded under the message it answers, remembered so a reply to it wakes Tex. */
async function say(storage: InboxStorage, deps: GroupDeps, message: Pick<GroupMessage, "line" | "groupId" | "messageId">, text: string): Promise<void> {
  if (!deps.sendblue) throw new ServiceError("sendblue", null);
  const handle = await sendGroupText(deps.fetch, deps.sendblue, { line: message.line, groupId: message.groupId }, text, message.messageId);
  if (handle === undefined) return;
  const sent = (await storage.get<string[]>(SENT_KEY)) ?? [];
  await storage.put(SENT_KEY, [...sent.filter((entry) => entry !== handle), handle].slice(-MAX_SENT));
}

/** One picture into the chat; one Sendblue refuses becomes a line saying so, as in a 1:1 text. */
async function sendPicture(storage: InboxStorage, deps: GroupDeps, message: GroupMessage, picture: OutgoingPicture): Promise<void> {
  if (!deps.sendblue) throw new ServiceError("sendblue", null);
  try {
    const url = "url" in picture ? picture.url : deps.hostPicture ? await deps.hostPicture(await shrinkPicture(deps.images, picture)) : null;
    if (url === null) throw new ServiceError("sendblue", 400);
    await sendGroupMedia(deps.fetch, deps.sendblue, { line: message.line, groupId: message.groupId }, url, message.messageId);
  } catch (error) {
    // The words already went: throwing would answer the whole turn again (three "Here's the one-pager"s and
    // then "I couldn't answer that one", 2026-10-26), so a picture that won't send is said once, never retried.
    log("picture_failed", error instanceof ServiceError ? `${error.service}:${error.status ?? "unreachable"}` : "host");
    await say(storage, deps, message, PICTURE_FAILED);
  }
}

/** The names this chat was asked to pick from, while that question is still open. */
async function openChoice(storage: InboxStorage, now: number): Promise<string[]> {
  const choice = await storage.get<Choice>(CHOICE_KEY);
  return choice !== undefined && now - choice.at < CHOICE_FOR_MS ? choice.slugs : [];
}

async function pruneSeen(storage: InboxStorage, now: number): Promise<void> {
  const seen = await storage.list<number>({ prefix: "gseen:" });
  for (const [key, at] of seen) if (now - at > SEEN_FOR_MS) await storage.delete(key);
}

/** One line per outcome, never a number, a name or the words. */
function log(outcome: string, reason?: string): void {
  console.log(JSON.stringify({ event: "group_turn", outcome, ...(reason ? { reason } : {}) }));
}
