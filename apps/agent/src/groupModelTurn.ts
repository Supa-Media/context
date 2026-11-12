/**
 * The model's turn on a group message (moved out of `groupInbox.ts` whole,
 * so the queue stays under its size limit): asked of the gateway, then
 * checked before it sends. Sent only to the people it was written for, and
 * only while it still answers its asker's newest words (`groupRecheck.ts`).
 */

import { canRedraft, chatEvent, readChatState } from "./chatState";
import { askAgentStream, askLine, ServiceError, type AgentAnswer } from "./clients";
import { CHAT_LOOK_PATH, saysSkip } from "./groupRoutines";
import type { ControlAnswer } from "./groupControl";
import { GROUP_LINES, PICTURE_LINE } from "./groupLines";
import { fixedTimings, log, logTiming, say, sayProgress, sendPicture, type SayMeta } from "./groupSay";
import { prepareAttachments } from "./attachments";
import { textsWithExact } from "./format";
import type { InboxStorage } from "./inbox";
import { groupLineFor } from "./groupLine";
import { membersBeforeSend } from "./groupMembers";
import { ackEmoji } from "./ackEmoji";
import { reactionFor } from "./reactEmoji";
import { chatBefore, dropChatLines, isBound, notePeople, peopleHash, sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { watchConversation } from "./reviewWatch";
import { chatJobs, jobQuestion, resumeJobs, startJobs, steerJobs, viewLink, withThreadsLine } from "./jobs";
import { addEvent, kindOf, logAsk, recentEvents } from "./events";
import { staleAsks } from "./decide";
import { startTurn } from "./steer";
import { recheckDraft } from "./groupRecheck";
import { tagsTex } from "./groupWords";
import type { GroupPending } from "./groupTurn";
import { ASK_KEY, filesFor, groupInboxName, routineDone, type GroupDeps, type OpenAsk } from "./groupInbox";

export type TurnInput = {
  message: GroupMessage;
  /** The messages it answers, one by one. */
  covered: GroupMessage[];
  acceptedAt: number;
  /** When the newest message it answers came in: the asker's words after it are what `recheckDraft` reads. */
  upTo: number;
  arrivedAt: number; // when the first message it answers came in, for the turn log's wait (`apps/mcp/src/agent/turnLog.js`)
  covers: string[];
  people: string[];
  asked: Extract<ControlAnswer, { status: "ready" }>;
  accessToken: string;
};

/** The model's turn on a group message, its answer sent only to the people it was written for. */
export async function groupTurn(storage: InboxStorage, deps: GroupDeps, { message, covered, acceptedAt, upTo, arrivedAt, covers, people, asked, accessToken }: TurnInput): Promise<"cancelled" | void> {
  const app = groupLineFor(deps, message.groupId);
  const chat = { line: message.line, groupId: message.groupId };
  const routine = message.routine !== undefined;
  const quoted = message.replyTo === undefined ? null : await app.readOwnMessage(chat, message.replyTo);
  const kept = await chatBefore(storage, message, acceptedAt, deps.now());
  // A chat line this turn answers is its question, not what the chat said around it.
  const asked_ = new Set(covered.map((entry) => `${entry.from}\n${entry.text}`));
  const said = { keys: kept.keys, lines: kept.lines.filter((line) => !asked_.has(`${line.from}\n${line.text}`)) };
  const handles = new Map((asked.names ?? []).map(({ phone, handle }) => [phone, handle]));
  // A guest is named in the chat's lines by a label from the control plane, never by number; never offered an email.
  const labels = new Map((asked.guests ?? []).map(({ phone, label }) => [phone, label]));
  // Pictures sent in the chat are read, as a 1:1 text's are (the group chat of 2026-10-23).
  const files = filesFor(message, said.lines);
  const attachments = files.length > 0 ? await prepareAttachments(files, { fetch: deps.fetch, images: deps.images }) : [];
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await peopleHash(message.line, people),
    ...(asked.handle ? { from: asked.handle } : {}),
    // Who is here, by handle, so an email can be offered to one of them to send (`apps/mcp/src/tools/offerFor.js`).
    people: [...new Set(handles.values())].filter(Boolean),
    // Each account's name beside its handle, so "@jo" is known as the "Jo Rivers" the notes name (2026-11-04).
    ...(named(asked.names).length > 0 ? { names: named(asked.names) } : {}),
    // Everyone else here by their label, never a number, and how many people the chat holds besides Tex, so "who is in
    // this chat" is answered from the whole list (Dev2, 2026-11-12).
    ...(guestLabels(people, labels).length > 0 ? { guests: guestLabels(people, labels) } : {}),
    size: people.length,
    // A literal "@Tex" is always answered (Dev2, 2026-11-12): the gateway offers no say_nothing, and a silent end is its fallback line.
    ...(covered.some((entry) => tagsTex(entry.text || entry.heard || "")) ? { tagged: true } : {}),
    // Mailboxes shared with this chat, named for the turn; the control plane decides every read (`chat-mail.md`).
    ...(asked.mail?.length ? { mail: asked.mail } : {}),
  };
  // The chat's next events are filed under the people this turn named the gateway (`eventPeople`).
  await notePeople(storage, message, group.members);
  // Named, so a message that lands while it runs can be folded into it (`steer.ts`), and those it took in are not answered again.
  const { steer, end, live } = startTurn(storage, message.groupId, message.from, deps, covers, (ids) => dropSteered(storage, ids, covers));
  await steer.onSession(accessToken);
  const meta: SayMeta = { turn: steer.turn, covers, people: group.members };
  /*
    Asked for as a stream, as a person's own text is (the owner, 2026-10-23:
    "group Tex should literally be the same exact as DM Tex"): a long ask
    texts its progress into the chat while it works, each line only while
    nobody new has joined, the same check the answer gets below. A newcomer
    pauses the turn's lines for good; a list that can't be read (twice, as
    `readTwice` reads it) holds only that line (2026-11-02). Each held line is
    logged as held, as the answer is. A routine (a job's report runs as one)
    texts once, so it says none (`apps/mcp/src/agent/route.js`); nor does a
    chat stopped or muted since the turn began. A line that won't send costs
    the chat a line, never the answer, as in a 1:1 text.
  */
  // The list kept from this turn's own read when the app reports changes and none came; else the app's, a failed
  // read retried at once: a blip is not a reason to hold (2026-11-02, 2026-11-12; `groupMembers.ts`).
  const readTwice = () => membersBeforeSend(storage, app, chat, deps.now);
  let paused = false;
  // One tapback on a slow ask, never with a text (Dev2, 2026-11-12): the first tool the turn starts taps the asked
  // message, at most once an answer and not after a progress line; a turn with no tool gets none.
  let acked = false;
  const toolStarted = async () => {
    if (acked || routine || message.jobReport !== undefined || message.reaction !== undefined) return;
    acked = true;
    try {
      if (!(await isBound(storage, message))) return;
      await groupLineFor(deps, message.groupId).react({ line: message.line, groupId: message.groupId }, message.messageId, reactionFor(undefined, ackEmoji(message.text)));
      log("tool_tap");
    } catch {
      log("tool_tap_failed");
    }
  };
  const progress = async (text: string) => {
    if (routine) return;
    try {
      if (!(await isBound(storage, message))) return log("progress_unbound");
      if (!paused) {
        const now = await readTwice();
        paused = now !== null && now.some((phone) => phone !== message.line && !people.includes(phone));
        if (now !== null && !paused) return void (acked = true, await sayProgress(storage, deps, message, text, meta));
      }
      await addEvent(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, kind: kindOf(text), text, delivered: false, reason: "held_newcomer", ...meta });
    } catch {
      log("progress_failed");
    }
  };
  let answer: AgentAnswer;
  const asking = deps.now();
  try {
    answer = await askAgentStream(
      deps.fetch,
      deps.gatewayOrigin,
      accessToken,
      {
        question: message.text,
        group: { ...group, chat: said.lines.map((line) => ({ from: handles.get(line.from) ?? labels.get(line.from) ?? "", text: line.text || PICTURE_LINE })) },
        turn: steer.turn,
        arrivedAt, ...(await fixedTimings(storage)), // fixed replies since the last turn, for the chat's note
        ...(covers.length > 0 ? { covers, chat: message.groupId, ...(await outbox(storage, message.groupId)) } : {}), // the chat's day is the gateway's ledger; the outbox goes on top
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(asked.timeZone ? { timeZone: asked.timeZone } : {}),
        ...(asked.instructions ? { instructions: asked.instructions } : {}), ...(asked.updates ? { updates: asked.updates } : {}), ...(message.jobReport ? { event: "job_report", jobReport: message.jobReport } : {}), // a job reporting to this chat's turn (`jobTexts.ts`)
        ...(deps.spawnJob ? { running: await chatJobs(storage, deps.now(), { results: true }) } : {}),
        ...(message.reaction !== undefined
          ? { quoted: message.reaction.words, tapback: message.reaction.how }
          : quoted !== null
            ? { quoted }
            : message.replyTo !== undefined
              ? { replied: true }
              : {}),
      },
      progress,
      toolStarted,
    );
  } finally {
    end();
  }
  const answered = deps.now();
  if (live.cancelled || answer.kind === "cancelled") {
    // Cancelled here though its answer came: what it armed is never left armed and unseen.
    if (answer.kind === "answer" && answer.askIds) await staleAsks(deps, accessToken, answer.askIds);
    return "cancelled";
  }
  // A routine the gateway couldn't run throws below like any turn, so its workflow retries it; failing every try reports it quietly.
  // A job's report refused a model is tried again, on a fresh grant, like any turn that failed: never dropped in silence
  // (a report whose token another of its asker's turns replaced mid-turn, 2026-11-08). Every try refused, `turnFailed` says so.
  if (message.jobReport !== undefined && answer.kind === "no_model") throw new ServiceError("gateway", 409);
  // Out of today's background turns, trying again is no use: the chat hears there is news, and the job list keeps it.
  if (message.jobReport !== undefined && answer.kind === "daily_limit") return void (await say(storage, deps, message, GROUP_LINES.jobReportRefused, { system: true, reason: "failed" }));
  if (routine && (answer.kind === "daily_limit" || answer.kind === "no_model")) return void (await routineDone(deps, message, answer.kind === "daily_limit" ? "daily_limit" : "no_provider"));
  if (answer.kind === "daily_limit") return void (await say(storage, deps, message, "That's all the questions for today. Ask me again tomorrow.", { system: true }));
  if (answer.kind === "no_model") return void (await say(storage, deps, message, "I can't answer from here yet.", { system: true }));
  if (answer.kind !== "answer") throw new ServiceError("gateway", answer.kind === "no_storage" ? 503 : answer.kind === "unavailable" && answer.timedOut ? 504 : null); // 503: the chat's workspace can't be opened (`failedLine`)
  if (answer.steered) await dropSteered(storage, answer.steered, covers);
  // Still what its asker wants? Their newer words, not folded in, may have changed it: held, it ends as a restart does.
  // At most `MAX_REDRAFTS` per burst (`chatState.ts`): past that the draft is sent as written, never redrafted forever.
  if (!routine && !message.jobReport && message.reaction === undefined && canRedraft(await readChatState(storage)) && (await recheckDraft(storage, deps, { message, covers, upTo, text: answer.text })) === "held") {
    await chatEvent(storage, "redraft", "recheck", { now: deps.now() });
    if (answer.askIds) await staleAsks(deps, accessToken, answer.askIds);
    return "cancelled";
  }
  // Long asks it handed off, and jobs it picked back up, also on a turn that texts nothing: a job's start is a tapback, never
  // a text (Dev2, 2026-11-11), and a quiet turn that returned first left the job never run.
  const ready = answer; // narrowed to an answer, for the closure
  const handOff = async () => {
    // Long asks it handed off run beside the chat (`jobs.ts`), each re-checking who is here when it answers.
    if (ready.jobs && deps.spawnJob) {
      await startJobs(storage, ready.jobs, {
        now: deps.now(),
        inbox: groupInboxName(message.groupId),
        origin: { kind: "group", message: { ...message, text: jobQuestion(message.text, ready) }, at: acceptedAt }, // typed, said aloud, and the files sent
        place: { line: message.line, groupId: message.groupId, messageId: message.messageId },
        spawn: deps.spawnJob,
      });
    }
    // A change to a job still running is handed to it, in the words of whoever texted it.
    const theirWords = { id: message.eventId, text: message.jobReport ? "" : jobQuestion(message.text, ready) }; // with a voice message's words and the files sent // a report's turn passes only its own notes
    if (ready.steers && deps.steerJob) await steerJobs(storage, ready.steers, theirWords, deps.steerJob, deps.now());
    if (ready.steers && deps.steerJob) await resumeJobs(storage, ready.steers, theirWords, deps.steerJob, deps.now()); // "restart it": an ended job picks up where it stopped, with their words
  };
  // Nothing to text (a group's SKIP, `apps/mcp/src/agent/route.js`): the gateway kept nothing, so this object keeps the chat's lines.
  if (!routine && answer.quiet && (answer.verbatim?.length ?? 0) === 0 && answer.pictures.length === 0) {
    // Answered with a tapback and no words: the conversation classifier's (`apps/mcp/src/agent/respond.js`), the emoji checked against the list.
    if (answer.react !== undefined && message.reaction === undefined && !acked) await groupLineFor(deps, message.groupId).react({ line: message.line, groupId: message.groupId }, message.messageId, reactionFor(answer.react || undefined, ackEmoji(message.text))).catch(() => {});
    await handOff();
    return log(answer.react !== undefined ? "reacted" : "silent");
  }
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
  // way in, an unread list is retried (`answerGroup`); here falling back to the
  // turn's people would run the other way, and this is the only thing standing
  // between an answer drawn from the bound workspace and somebody who is not a
  // member of it. So a list unread twice holds the answer, as a joiner does.
  if (routine && (answer.quiet || saysSkip(answer.text)) && (answer.verbatim?.length ?? 0) === 0 && answer.pictures.length === 0) {
    await handOff();
    return void (await routineDone(deps, message, "skipped"));
  }
  const checkIn = message.routine?.path === CHAT_LOOK_PATH; // A check-in posts one bubble and no card (Dev2, 2026-10-28).
  const toSend = textsWithExact(answer.text, answer.verbatim, checkIn);
  const threaded = checkIn ? toSend : await withThreadsLine(toSend, answer.offers, viewLink(answer.hub, deps.threadsLink), answer.verbatim); // the live view rides in the first text (`jobs.ts`)
  const texts = withIntro(threaded, !routine && asked.intro === true ? GROUP_LINES.intro(asked.reach ?? []) : null, answer.verbatim);
  const now = await readTwice();
  if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) {
    log(now === null ? "members_unread_after" : "joined");
    if (routine) return void (await routineDone(deps, message, now === null ? "failed" : "no_chat"));
    // Held for the newcomer: logged as never delivered, and the chat is told why.
    for (const text of texts) await addEvent(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, kind: kindOf(text), text, delivered: false, reason: "held_newcomer", ...meta });
    return void (await say(storage, deps, message, now === null ? GROUP_LINES.failed : GROUP_LINES.joined, { system: true, ...(now === null ? { reason: "failed" as const } : {}) }));
  }
  await chatEvent(storage, "send", routine ? "routine" : "turn", { now: deps.now() });
  // Plain in the chat when the classifier says the answer reads as one to this text anyway; a text typed under another is answered under it (`respond.js`).
  if (!routine && answer.place === "plain" && message.replyTo === undefined) meta.plain = true;
  // Every bubble under the message it answers, not only the first (Dev2's bug report, 2026-10-21).
  let firstSent: number | undefined; // when the person's wait ended (`textTiming.ts`)
  for (const text of texts) {
    await say(storage, deps, message, text, meta);
    firstSent ??= deps.now();
  }
  for (const picture of checkIn ? [] : answer.pictures) await sendPicture(storage, deps, message, picture, meta); // After the words, as in a 1:1.
  // Each ask is the asked person's: only their words can make it stale, only their session disarms it.
  const askedWho = await sha256Hex(asks ?? message.from);
  for (const record of answer.askIds ?? []) await logAsk(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, turn: meta.turn, people: meta.people }, record, askedWho, askLine(answer));
  log("answered");
  logTiming({ arrivedAt, asking, answered, firstSent, sent: deps.now(), parts: texts.length, turn: meta.turn ?? "" }, deps.textTiming);
  await routineDone(deps, message, "answered", texts.length > 0 ? 1 : 0);
  // Twenty quiet minutes from now, this conversation is scored (`reviewWatch.ts`).
  await watchConversation(storage, { kind: "group", message, people }, deps.now());
  await handOff();
}

/** The chat's people with a name on their account, by handle. */
/** The labels of the people here with no account the control plane linked, each once, in the chat's order. */
function guestLabels(people: string[], labels: Map<string, string>): string[] {
  return [...new Set(people.flatMap((phone) => (labels.has(phone) ? [labels.get(phone) as string] : [])))];
}

function named(names: { handle: string; name?: string }[] | undefined): { handle: string; name: string }[] {
  return (names ?? []).filter((entry) => entry.handle !== "" && typeof entry.name === "string" && entry.name !== "").map(({ handle, name }) => ({ handle, name: name as string }));
}

/** Drop the waiting messages a turn took in as it ran; it answered them, so its answer covers them. */
async function dropSteered(storage: InboxStorage, ids: string[], covers: string[]): Promise<void> {
  for (const [key, item] of await storage.list<GroupPending>({ prefix: "gpending:" })) {
    if (!ids.includes(item.message.eventId)) continue;
    if (item.ev !== undefined && !covers.includes(item.ev)) covers.push(item.ev);
    await storage.delete(key);
  }
}

/** The events the gateway has not taken yet, for it to add to the chat's day from the ledger (`apps/mcp/src/agent/warmCopy.js` `mergeEvents`). */
async function outbox(storage: InboxStorage, chat: string): Promise<{ recent?: unknown[] }> {
  const recent = await recentEvents(storage, chat);
  return recent.length > 0 ? { recent } : {};
}

/**
 * The one-shot introduction as the last line of a chat's first answer (Dev2, 2026-11-12): one send into a new group,
 * not a fixed bubble ahead of the answer. An exact text (an ask's own words) is never changed, so after one it is a
 * text of its own; a turn that texts nothing has nothing to carry it.
 */
export function withIntro(texts: string[], intro: string | null, exact: readonly string[] = []): string[] {
  if (intro === null || texts.length === 0) return texts;
  const last = texts.at(-1)!;
  // A bare link keeps its preview, and an exact text its words: the intro goes after either as its own text.
  return /^https?:\/\/\S+$/.test(last.trim()) || exact.some((part) => part.trim() === last.trim()) ? [...texts, intro] : [...texts.slice(0, -1), `${last}\n\n${intro}`];
}
