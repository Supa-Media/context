/**
 * The model's turn on a group message (moved out of `groupInbox.ts` whole,
 * so the queue stays under its size limit): asked of the gateway, then
 * checked before it sends. Sent only to the people it was written for, and
 * only while it still answers its asker's newest words (`groupRecheck.ts`).
 */

import { askAgentStream, askLine, ServiceError, type AgentAnswer } from "./clients";
import { CHAT_LOOK_PATH, saysSkip } from "./groupRoutines";
import type { ControlAnswer } from "./groupControl";
import { GROUP_LINES, PICTURE_LINE } from "./groupLines";
import { fixedTimings, log, logTiming, say, sendPicture, type SayMeta } from "./groupSay";
import { prepareAttachments } from "./attachments";
import { textsWithExact } from "./format";
import type { InboxStorage } from "./inbox";
import { groupLineFor } from "./groupLine";
import { chatBefore, dropChatLines, notePeople, peopleHash, sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { watchConversation } from "./reviewWatch";
import { chatJobs, startJobs, steerJobs, threadsLines } from "./jobs";
import { addEvent, kindOf, logAsk } from "./events";
import { staleAsks } from "./decide";
import { startTurn } from "./steer";
import { recheckDraft } from "./groupRecheck";
import type { GroupPending } from "./groupTurn";
import { texSpoke } from "./groupStyle";
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
    nobody new has joined, the same check the answer gets below.
  */
  const progress = async (text: string) => {
    const now = await app.readMembers(chat);
    if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) return;
    await say(storage, deps, message, text, meta);
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
        ...(covers.length > 0 ? { covers, chat: message.groupId } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(asked.timeZone ? { timeZone: asked.timeZone } : {}),
        ...(asked.texStyle ? { texStyle: asked.texStyle } : {}), ...(message.jobReport ? { event: "job_report", jobReport: message.jobReport } : {}), // a job reporting to this chat's turn (`jobTexts.ts`)
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
  if (routine && (answer.kind === "daily_limit" || answer.kind === "no_model")) return void (await routineDone(deps, message, answer.kind === "daily_limit" ? "daily_limit" : "no_provider"));
  if (answer.kind === "daily_limit") return void (await say(storage, deps, message, "That's all the questions for today. Ask me again tomorrow.", { system: true }));
  if (answer.kind === "no_model") return void (await say(storage, deps, message, "I can't answer from here yet.", { system: true }));
  if (answer.kind !== "answer") throw new ServiceError("gateway", answer.kind === "no_storage" ? 503 : answer.kind === "unavailable" && answer.timedOut ? 504 : null); // 503: the chat's workspace can't be opened (`failedLine`)
  if (answer.steered) await dropSteered(storage, answer.steered, covers);
  // Still what its asker wants? Their newer words, not folded in, may have changed it: held, it ends as a restart does.
  if (!routine && !message.jobReport && message.reaction === undefined && (await recheckDraft(storage, deps, { message, covers, upTo, text: answer.text })) === "held") {
    if (answer.askIds) await staleAsks(deps, accessToken, answer.askIds);
    return "cancelled";
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
  // way in, falling back to the webhook's own names is safe because more names
  // only ever narrow the workspace the chat may use; here the fallback would
  // run the other way, and this is the only thing standing between an answer
  // drawn from the bound workspace and somebody who is not a member of it. So
  // an unreadable list holds the answer, as a joiner does.
  if (routine && saysSkip(answer.text) && (answer.verbatim?.length ?? 0) === 0 && answer.pictures.length === 0) return void (await routineDone(deps, message, "skipped"));
  const checkIn = message.routine?.path === CHAT_LOOK_PATH; // A check-in posts one bubble and no card (Dev2, 2026-10-28).
  const texts = [...textsWithExact(answer.text, answer.verbatim, checkIn || asked.texStyle?.bubbles === "one"), ...(checkIn ? [] : await threadsLines(answer.offers, deps.threadsLink))];
  const now = await app.readMembers(chat);
  if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) {
    log(now === null ? "members_unread_after" : "joined");
    if (routine) return void (await routineDone(deps, message, now === null ? "failed" : "no_chat"));
    // Held for the newcomer: logged as never delivered, and the chat is told why.
    for (const text of texts) await addEvent(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, kind: kindOf(text), text, delivered: false, reason: "held_newcomer", ...meta });
    return void (await say(storage, deps, message, now === null ? GROUP_LINES.failed : GROUP_LINES.joined, { system: true, ...(now === null ? { reason: "failed" as const } : {}) }));
  }
  // Every bubble under the message it answers, not only the first (Jhon's bug report, 2026-10-21).
  for (const text of texts) await say(storage, deps, message, text, meta);
  for (const picture of checkIn ? [] : answer.pictures) await sendPicture(storage, deps, message, picture, meta); // After the words, as in a 1:1.
  // Each ask is the asked person's: only their words can make it stale, only their session disarms it.
  const askedWho = await sha256Hex(asks ?? message.from);
  for (const record of answer.askIds ?? []) await logAsk(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, turn: meta.turn, people: meta.people }, record, askedWho, askLine(answer));
  await texSpoke(storage);
  log("answered");
  logTiming({ arrivedAt, asking, answered, sent: deps.now() });
  await routineDone(deps, message, "answered", texts.length > 0 ? 1 : 0);
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
  if (answer.steers && deps.steerJob) await steerJobs(storage, answer.steers, { id: message.eventId, text: message.jobReport ? "" : message.text }, deps.steerJob, deps.now()); // a report's turn passes only its own notes
}

/** Drop the waiting messages a turn took in as it ran; it answered them, so its answer covers them. */
async function dropSteered(storage: InboxStorage, ids: string[], covers: string[]): Promise<void> {
  for (const [key, item] of await storage.list<GroupPending>({ prefix: "gpending:" })) {
    if (!ids.includes(item.message.eventId)) continue;
    if (item.ev !== undefined && !covers.includes(item.ev)) covers.push(item.ev);
    await storage.delete(key);
  }
}

