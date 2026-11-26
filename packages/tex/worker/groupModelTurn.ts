/**
 * The model's turn on a group message (moved out of `groupInbox.ts` whole,
 * so the queue stays under its size limit): asked of the gateway, then
 * checked before it sends. Sent only to the people it was written for, and
 * only while it still answers its asker's newest words (`groupRecheck.ts`).
 */

import { didUnsaid, tellTex } from "./didFacts";
import { canRedraft, chatEvent, readChatState } from "./chatState";
import { askAgentStream, askLine, ServiceError, type AgentAnswer } from "./clients";
import { CHAT_LOOK_PATH, saysSkip } from "./groupRoutines";
import { maySend } from "./outboundGuard";
import type { ControlAnswer } from "./groupControl";
import { GROUP_LINES, PICTURE_LINE } from "./groupLines";
import { fixedTimings, log, logOut, logTiming, say, sayProgress, sendPicture, threadUnder, type SayMeta } from "./groupSay";
import { prepareAttachments } from "./attachments";
import { E164 } from "./sendblue";
import { bubblesUnder } from "./bubblesUnder";
import type { InboxStorage } from "./inbox";
import { groupLineFor, groupLineSeam } from "./groupLine";
import { membersBeforeSend } from "./groupMembers";
import { deliveryStep, logStep, tapback } from "./stepEvents";
import { chatBefore, dropChatLines, isBound, notePeople, peopleHash, peopleOf, setChatBound, sha256Hex } from "./groupChat";
import type { GroupMessage } from "./sendblueGroups";
import { watchConversation } from "./reviewWatch";
import { dropKept } from "./groupKept";
import { chatJobs, jobQuestion, resumeJobs, startJobs, steerJobs, viewLink, withThreadsLine } from "./jobs";
import { addEvent, kindOf, logAsk, recentEvents } from "./events";
import { staleAsks } from "./decide";
import { startTurn } from "./steer";
import { recheckDraft } from "./groupRecheck";
import { tagsTex } from "./groupWords";
import { turnCause } from "./groupCause";
import { watchForSave } from "./vaultWatch";
import { watchForHandback } from "./handbackWatch";
import { inviteEveryone } from "./groupInvite";
import { groupRunDoneWords, runTheGroup } from "./groupRunTurn";
import type { GroupPending } from "./groupTurn";
import { ASK_KEY, filesFor, groupInboxName, routineDone, type GroupDeps, type OpenAsk } from "./groupInbox";
import { answerCrossAsk, crossCounts, crossFields, crossWired, sendAsides, sendCrossAsks } from "./crossChat";

export type TurnInput = {
  message: GroupMessage;
  /** The messages it answers, one by one. */
  covered: GroupMessage[];
  acceptedAt: number;
  /** When the newest message it answers came in: the asker's words after it are what `recheckDraft` reads. */
  upTo: number;
  arrivedAt: number; // when the first message it answers came in, for the turn log's wait (`packages/tex/gateway/agent/turnLog.js`)
  covers: string[];
  people: string[];
  asked: Extract<ControlAnswer, { status: "ready" }>;
  accessToken: string;
  /** Each text it answers, its event id to its message id: where a part of the answer threads (`bubblesUnder.ts`). */
  messages?: Readonly<Record<string, string>>;
};

/** The model's turn on a group message, its answer sent only to the people it was written for. */
export async function groupTurn(storage: InboxStorage, deps: GroupDeps, { message, covered, acceptedAt, upTo: handedUpTo, arrivedAt, covers, people, asked, accessToken, messages: given = {} }: TurnInput): Promise<"cancelled" | void> {
  // Grown by what the turn takes in as it runs (`dropSteered`): those texts are answered here, and a part can go under each.
  const messages: Record<string, string> = { ...given };
  let upTo = handedUpTo;
  const app = groupLineFor(groupLineSeam(deps), message.groupId);
  const chat = { line: message.line, groupId: message.groupId };
  const routine = message.routine !== undefined;
  const crossOn = deps.crossCall !== undefined && !message.sms && crossWired(deps.texGraph); // Tex asks Tex across chats, once the config wires the gate (`crossChat.ts`)
  const quoted = message.replyTo === undefined ? null : (message.quoted ?? (await app.readOwnMessage(chat, message.replyTo)));
  const kept = await chatBefore(storage, message, acceptedAt, deps.now());
  // A chat line this turn answers is its question, not what the chat said around it.
  const asked_ = new Set(covered.map((entry) => `${entry.from}\n${entry.text}`));
  // A check-in is only its prompt (Dev2, 2026-11-20): the chat's history already shows every line and picture at its
  // own time and sender, so the lines since Tex last spoke, and their pictures, are never handed in as this turn's input.
  // Handed in, a screenshot posted the night before read as sent with the check-in, by whoever spoke last.
  const lookOnly = message.routine?.path === CHAT_LOOK_PATH;
  const said = { keys: kept.keys, lines: lookOnly ? [] : kept.lines.filter((line) => !asked_.has(`${line.from}\n${line.text}`)) };
  const handles = new Map((asked.names ?? []).map(({ phone, handle }) => [phone, handle]));
  // A guest is named in the chat's lines by a label from the control plane, never by number; never offered an email.
  const labels = new Map((asked.guests ?? []).map(({ phone, label }) => [phone, label]));
  // Pictures sent in the chat are read, as a 1:1 text's are (the group chat of 2026-10-23).
  const files = filesFor(message, said.lines);
  const attachments = files.length > 0 ? await prepareAttachments(files, { fetch: deps.fetch, images: deps.images }) : [];
  // Who is here, for naming and counting: the list the message itself carries (Dev2, 2026-11-12: Sendblue's members
  // lookup kept someone who had left, and Tex counted them). The lookup still widens `members`, so it only narrows.
  const here = whoIsHere(message, people);
  const group = {
    key: await sha256Hex(`${message.line}:${message.groupId}`),
    members: await peopleHash(message.line, people),
    ...(asked.handle ? { from: asked.handle } : {}),
    // Who is here, by handle, so an email can be offered to one of them to send (`apps/mcp/src/tools/offerFor.js`).
    people: [...new Set(here.flatMap((phone) => (handles.has(phone) ? [handles.get(phone) as string] : [])))].filter(Boolean),
    // Each account's name beside its handle, so "@jo" is known as the "Jo Rivers" the notes name (2026-11-04).
    ...(named(asked.names).length > 0 ? { names: named(asked.names) } : {}),
    // Everyone else here by their label, never a number, and how many people the chat holds besides Tex, so "who is in
    // this chat" is answered from the whole list (Dev2, 2026-11-12).
    ...(guestLabels(here, labels).length > 0 ? { guests: guestLabels(here, labels) } : {}),
    // Each person's number beside the handle or label they are known by (Dev2, 2026-11-12): everyone in the chat
    // already sees it, and a person says a number where Tex would say a label.
    ...(numbersHere(here, handles, labels).length > 0 ? { numbers: numbersHere(here, handles, labels) } : {}),
    ...(!asked.handle && labels.has(message.from) ? { asker: labels.get(message.from) } : {}),
    size: here.length,
    // A literal "@Tex" is always answered (Dev2, 2026-11-12): the gateway offers no say_nothing, and a silent end is its fallback line.
    ...(covered.some((entry) => tagsTex(entry.text || entry.heard || "")) ? { tagged: true } : {}),
    // Why this turn runs, so the gateway never tells Tex it was tagged when it wasn't (`groupCause.ts`).
    cause: turnCause(message, covered),
    // Mailboxes shared with this chat, named for the turn; the control plane decides every read (`chat-mail.md`).
    ...(asked.mail?.length ? { mail: asked.mail } : {}),
    // Calendars shared with this chat, named for the turn; the control plane decides every read (Dev2, 2026-11-19).
    ...(asked.calendar?.length ? { calendar: asked.calendar } : {}),
    // Who keeps the chat from a workspace its asker and sponsor share (`lib/textGroupBlockers.ts`), so the turn logs it
    // and Tex names who and the fix, by text (Dev2, 2026-11-16).
    ...(asked.blocked?.length ? { blocked: asked.blocked } : {}),
    // The asker's workspaces this turn reads that someone here can't open, for the Room check before send (Dev2, 2026-11-26).
    ...(asked.unshared?.length ? { unshared: asked.unshared } : {}),
    // Whether the developers who build Tex can read this chat in their Lab, and who said yes (Dev2, 2026-11-17).
    ...(asked.devShare ? { devShare: asked.devShare } : {}),
  };
  // The chat's next events are filed under the people this turn named the gateway (`eventPeople`).
  await notePeople(storage, message, group.members);
  // Named, so a message that lands while it runs can be folded into it (`steer.ts`), and those it took in are not answered again.
  const { steer, end, live } = startTurn(storage, message.groupId, message.from, deps, covers, (ids) => dropSteered(storage, ids, covers, messages).then((at) => void (upTo = Math.max(upTo, at))));
  await steer.onSession(accessToken);
  // A provisional run (`provisional.ts`): its go or stop goes to this turn, and nothing below reaches the chat before the go.
  const gate = deps.provisional;
  gate?.bind(steer.turn, accessToken);
  const stopped = async () => gate !== undefined && (await gate.decided) === "stop";
  const meta: SayMeta = { turn: steer.turn, covers, people: group.members };
  /*
    Asked for as a stream, as a person's own text is (the owner, 2026-10-23:
    "group Tex should literally be the same exact as DM Tex"): a long ask
    texts its progress into the chat while it works, each line only while
    nobody new has joined, the same check the answer gets below. A newcomer
    pauses the turn's lines for good; a list that can't be read (twice, as
    `readTwice` reads it) holds only that line (2026-11-02). Each held line is
    logged as held, as the answer is. A routine (a job's report runs as one)
    texts once, so it says none (`packages/tex/gateway/agent/route.js`); nor does a
    chat stopped or muted since the turn began. A line that won't send costs
    the chat a line, never the answer, as in a 1:1 text.
  */
  // The list kept from this turn's own read when the app reports changes and none came; else the app's, a failed
  // read retried at once: a blip is not a reason to hold (2026-11-02, 2026-11-12; `groupMembers.ts`).
  const readTwice = () => membersBeforeSend(storage, app, chat, deps.now);
  let paused = false;
  // No tapback from code on a slow ask (Dev2, 2026-11-26, replacing the tool-start tapback of 2026-11-12): when the
  // reply will take a while, Tex texts a short line of its own first (`text_progress`), as Training teaches it.
  // `acked`: a progress line went, so a tapback-only ending does not land beside it.
  let acked = false;
  const progress = async (text: string) => {
    if (routine || (await stopped())) return;
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
  if (gate?.verdict === "stop") return end(), "cancelled";
  try {
    answer = await askAgentStream(
      deps.fetch,
      deps.gatewayOrigin,
      accessToken,
      {
        question: message.text,
        group: { ...group, chat: said.lines.map((line) => ({ from: handles.get(line.from) ?? labels.get(line.from) ?? "", text: line.text || PICTURE_LINE })) },
        turn: steer.turn,
        ...(gate !== undefined ? { provisional: true, allow: gate.allow } : {}),
        arrivedAt, ...(await fixedTimings(storage)), ...(deps.again ? { again: true } : {}), // a try after one that failed (`packages/tex/gateway/agent/savedRounds.js`) // fixed replies since the last turn, for the chat's note
        ...(covers.length > 0 ? { covers, chat: message.groupId, ...(await outbox(storage, message.groupId)) } : {}), // the chat's day is the gateway's ledger; the outbox goes on top
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(asked.timeZone ? { timeZone: asked.timeZone } : {}),
        ...(asked.instructions ? { instructions: asked.instructions } : {}), ...(asked.updates ? { updates: asked.updates } : {}), ...(message.jobReport ? { event: "job_report", jobReport: message.jobReport } : message.crossChat ? crossFields(message.crossChat) : message.event !== undefined ? { event: message.event, ...(message.did ? { did: message.did } : {}) } : {}), ...(crossOn ? { crossCounts: await crossCounts(storage, deps.now()) } : {}), // a job reporting to this chat's turn (`jobTexts.ts`), or a login it asked for saved (`vaultWatch.ts`)
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
  if (live.cancelled || answer.kind === "cancelled" || (await stopped())) {
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
  if (answer.kind === "daily_limit" || answer.kind === "no_model") if (await didUnsaid(storage, deps, message, answer.kind)) return;
  if (routine && (answer.kind === "daily_limit" || answer.kind === "no_model")) return void (await routineDone(deps, message, answer.kind === "daily_limit" ? "daily_limit" : "no_provider"));
  if (answer.kind === "daily_limit") return void (await say(storage, deps, message, "That's all the questions for today. Ask me again tomorrow.", { system: true }));
  if (answer.kind === "no_model") return void (await say(storage, deps, message, "I can't answer from here yet.", { system: true }));
  if (answer.kind !== "answer") throw new ServiceError("gateway", answer.kind === "no_storage" ? 503 : answer.kind === "unavailable" && answer.timedOut ? 504 : null); // 503: the chat's workspace can't be opened (`failedLine`)
  if (answer.steered) upTo = Math.max(upTo, await dropSteered(storage, answer.steered, covers, messages));
  // The turn muted this chat (`chat_mute`): it is told so in the fixed words "Tex, stop" gets, by code, whatever the turn
  // texted or held back, and nothing else of the turn is sent (Dev2, 2026-11-20: a reviewer sent the turn's own line
  // back and the chat was muted for a week without anyone hearing).
  if (answer.muted && !routine && message.jobReport === undefined) {
    if (answer.askIds) await staleAsks(deps, accessToken, answer.askIds);
    await setChatBound(storage, null, true);
    await dropKept(storage); // the kept "ready" answer would let the same person's next ask run a turn (`groupKept.ts`)
    await say(storage, deps, message, GROUP_LINES.stopped, { system: true });
    return log("muted_by_turn");
  }
  // A link to save a login went: this chat watches that link, and its save carries the task on here (`vaultWatch.ts`).
  if (answer.vaultWatch) await watchForSave(storage, message.from, deps.now(), { ...(answer.vaultLinks ? { links: answer.vaultLinks } : {}), group: { groupId: message.groupId, line: message.line, messageId: message.messageId, text: message.text } });
  // A take-over link went: Done on it carries the task on here (`handbackWatch.ts`).
  if (answer.handbackWatch) await watchForHandback(storage, message.from, deps.now(), answer.handbackWatch, { groupId: message.groupId, line: message.line, messageId: message.messageId, text: message.text });
  // Still what its asker wants? Their newer words, not folded in, may have changed it: held, it ends as a restart does.
  // At most `MAX_REDRAFTS` per burst (`chatState.ts`): past that the draft is sent as written, never redrafted forever.
  if (!routine && !message.jobReport && message.reaction === undefined && canRedraft(await readChatState(storage)) && (await recheckDraft(storage, deps, { message, covers, upTo, text: answer.text })) === "held") {
    await chatEvent(storage, "redraft", "recheck", { now: deps.now() });
    if (answer.askIds) await staleAsks(deps, accessToken, answer.askIds);
    return "cancelled";
  }
  // Long asks it handed off, and jobs it picked back up, also on a turn that texts nothing: a job's start is a tapback, never
  // a text (Dev2, 2026-11-11), and a quiet turn that returned first left the job never run.
  // Asks the Cross-chat gate let go start in their chats; a run answering another chat's ask sends its answer back and
  // texts nothing here but a do-ask's one signed line, and only to the people it was written for (`crossChat.ts`).
  // Sensitive asks go to the tagger's own 1:1, never here (`crossChat.ts` `sendAsides`); one that can't is said here in fixed words.
  if (answer.asides && message.crossChat?.kind !== "ask") {
    const aside = deps.crossCall ? await sendAsides({ now: deps.now, call: deps.crossCall }, message, answer.asides) : "unreached";
    if (aside !== "sent") await tellTex(storage, deps, message, { action: "text_on_the_side", status: aside === "no_1to1" ? "no_1to1" : "failed" }, aside === "no_1to1" ? GROUP_LINES.asideNo1to1 : GROUP_LINES.asideFailed);
  }
  if (crossOn && answer.crossAsks) await sendCrossAsks(storage, { now: deps.now, call: deps.crossCall! }, { kind: "group", message }, answer.crossAsks);
  if (message.crossChat?.kind === "ask") {
    if (crossOn && answer.crossPost) {
      const here = await readTwice();
      if (here !== null && !here.some((phone) => phone !== message.line && !people.includes(phone))) await say(storage, deps, message, answer.crossPost, meta);
      else log("cross_post_held");
    }
    if (crossOn) await answerCrossAsk({ now: deps.now, call: deps.crossCall! }, message.crossChat, answer.crossBack ?? { id: message.crossChat.id, state: "refused", texts: [], why: "no answer came out of the turn" });
    return log("cross_answered");
  }
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
  // Nothing to text (a group's SKIP, `packages/tex/gateway/agent/route.js`): the gateway kept nothing, so this object keeps the chat's lines.
  if (!routine && answer.quiet && (answer.verbatim?.length ?? 0) === 0 && answer.pictures.length === 0) {
    // Answered with a tapback and no words: the conversation classifier's (`packages/tex/gateway/agent/respond.js`), the emoji checked against the list.
    // Tex's own pick (the front door's `tapback`, `packages/tex/gateway/agent/tapbackEnding.js`), never beside a progress line it texted.
    // Tex's pick may be a sticker this chat kept (`stickers.ts`): it goes on their text beside any tapback, its emoji the fallback.
    const sticker = answer.react ? answer.sticker : undefined;
    if (answer.react !== undefined && message.reaction === undefined && message.answersTapback === undefined && (!acked || sticker !== undefined)) {
      const line = groupLineFor(groupLineSeam(deps), message.groupId);
      const place = { line: message.line, groupId: message.groupId };
      const stick = line.stick === undefined ? undefined : (guid: string) => line.stick!(place, message.messageId, { attachment: guid });
      await tapback(storage, { chat: message.groupId, now: deps.now, by: answer.react ? "tex" : "classifier", asked: answer.react || undefined, turn: steer.turn }, message.text, (sent) => line.react(place, message.messageId, sent), sticker !== undefined ? { id: sticker, stick } : undefined).catch(() => {});
    }
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
  // A scheduled turn's skip is a decision, read off the whole answer before it is cut into bubbles: the gateway's flag, or,
  // behind it, words that are or end in the quiet word (2026-11-17: a check-in's reasoning and "SKIP" posted; `outboundGuard.ts`).
  const skipped = routine && !answer.quiet && !saysSkip(answer.text) && !maySend(answer.text, "group_routine");
  if (routine && (answer.quiet || skipped || saysSkip(answer.text)) && (answer.verbatim?.length ?? 0) === 0 && answer.pictures.length === 0) {
    await handOff();
    return void (await routineDone(deps, message, "skipped"));
  }
  const checkIn = message.routine?.path === CHAT_LOOK_PATH; // A check-in posts one bubble and no card (Dev2, 2026-10-28).
  // Each part under the text it answers when one turn answered several (`bubblesUnder.ts`); else every bubble under the newest.
  const bubbles = bubblesUnder(answer.text, routine ? [] : (answer.under ?? []), messages, answer.verbatim, checkIn);
  const toSend = bubbles.map((bubble) => bubble.text);
  const threaded = checkIn ? toSend : await withThreadsLine(toSend, answer.offers, viewLink(answer.hub, deps.threadsLink), answer.verbatim); // the live view rides in the first text (`jobs.ts`)
  let texts = withIntro(threaded, !routine && asked.intro === true ? GROUP_LINES.intro(asked.reach ?? []) : null, answer.verbatim);
  // A line added after the answer (the view, the intro) goes where the answer's last bubble went.
  const underOf = (index: number): string | undefined => bubbles[Math.min(index, bubbles.length - 1)]?.messageId;
  const eventOf = (messageId: string): string | undefined => Object.entries(messages).find(([, id]) => id === messageId)?.[0];
  const now = await readTwice();
  if (now === null || now.some((phone) => phone !== message.line && !people.includes(phone))) {
    log(now === null ? "members_unread_after" : "joined");
    if (await didUnsaid(storage, deps, message, now === null ? "failed" : "joined")) return;
    if (routine) return void (await routineDone(deps, message, now === null ? "failed" : "no_chat"));
    // Held for the newcomer: logged as never delivered, and the chat is told why.
    for (const text of texts) await addEvent(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, kind: kindOf(text), text, delivered: false, reason: "held_newcomer", ...meta });
    return void (await say(storage, deps, message, now === null ? GROUP_LINES.failed : GROUP_LINES.joined, { system: true, ...(now === null ? { reason: "failed" as const } : {}) }));
  }
  // "(name the chat) …", "(set the chat photo)", "(add to the chat) …": done before the words, checked on this message (`groupRun.ts`).
  const ran = routine ? null : await runTheGroup(texts, message, groupLineFor(groupLineSeam(deps), message.groupId), { line: message.line, groupId: message.groupId });
  if (ran !== null) texts = ran.texts;
  await chatEvent(storage, "send", routine ? "routine" : "turn", { now: deps.now() });
  // Plain in the chat when the classifier says the answer reads as one to this text anyway; a text typed under another is answered under it (`respond.js`).
  if (!routine && answer.place === "plain" && message.replyTo === undefined) meta.plain = true;
  // Every bubble under the message it answers, not only the first (Dev2's bug report, 2026-10-21).
  let firstSent: number | undefined; // when the person's wait ended (`textTiming.ts`)
  // Text them's own time, on the wall clock (`now` can be fixed for the whole text): the parts handed to the line (`deliveryStep`).
  const delivering = Date.now();
  const parts = texts.length + (checkIn ? 0 : answer.pictures.length);
  let went = 0;
  try {
    for (const [index, text] of texts.entries()) {
      if (text === "") continue; // only "running the group" lines, done above
      const messageId = meta.plain ? undefined : underOf(index);
      const under = messageId === undefined ? message : { ...message, messageId };
      // Logged as a reply to the text it went under, so Replay shows where each bubble went.
      const replyTo = meta.plain || threadUnder(under) !== under.messageId ? undefined : eventOf(under.messageId);
      await say(storage, deps, under, text, replyTo === undefined ? meta : { ...meta, replyTo });
      firstSent ??= deps.now();
      went += 1;
    }
    for (const picture of checkIn ? [] : answer.pictures) (await sendPicture(storage, deps, message, picture, meta), (went += 1)); // After the words, as in a 1:1.
    if (ran?.told) await tellTex(storage, deps, message, { action: "run_group", status: ran.why ?? "failed" }, ran.told);
    for (const action of ran?.done ?? []) await logOut(storage, deps, message.groupId, { kind: "text", text: groupRunDoneWords(action), delivered: true }, meta); // kept, so the next turn knows it was done
  } catch (error) {
    if (meta.turn) await logStep(storage, message.groupId, deliveryStep(parts, went, Date.now() - delivering, error instanceof Error ? error.name : "error"), deps.now(), meta.turn);
    throw error;
  }
  if (meta.turn) await logStep(storage, message.groupId, deliveryStep(parts, went, Date.now() - delivering), deps.now(), meta.turn);
  // Each ask is the asked person's: only their words can make it stale, only their session disarms it.
  const askedWho = await sha256Hex(asks ?? message.from);
  for (const record of answer.askIds ?? []) await logAsk(storage, { at: deps.now(), chat: message.groupId, from: { kind: "tex" }, turn: meta.turn, people: meta.people }, record, askedWho, askLine(answer));
  // "Share @studio with everyone here": the invitation goes as its asker now the answer has (`groupInvite.ts`).
  if (answer.invite && !routine) await inviteEveryone(storage, deps, message, people, answer.invite);
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

/**
 * The people a message's own list names, without Tex's line, when it names anyone besides the sender; otherwise (a
 * routine, a webhook naming only the sender) everyone the turn was given.
 */
function whoIsHere(message: GroupMessage, people: string[]): string[] {
  const listed = peopleOf(message.line, message.participants);
  return listed.some((person) => person !== message.from) ? listed : people;
}

/** Each person here with a handle or label, by it, with their number: real numbers only, each person once. */
function numbersHere(people: string[], handles: Map<string, string>, labels: Map<string, string>): { who: string; phone: string }[] {
  const seen = new Set<string>();
  return people.flatMap((phone) => {
    const who = handles.get(phone) ?? labels.get(phone);
    if (who === undefined || who === "" || seen.has(who) || !E164.test(phone)) return [];
    seen.add(who);
    return [{ who, phone }];
  });
}

function named(names: { handle: string; name?: string }[] | undefined): { handle: string; name: string }[] {
  return (names ?? []).filter((entry) => entry.handle !== "" && typeof entry.name === "string" && entry.name !== "").map(({ handle, name }) => ({ handle, name: name as string }));
}

/**
 * Drop the waiting messages a turn took in as it ran; it answered them, so its answer covers them, and a part of it can
 * go under each (`messages`). Named by the line's event id (steered in, `steer.ts`) or by the chat's own (the asker's
 * texts that landed behind the turn, `packages/tex/gateway/agent/takenBehind.js`). Answers when the newest of them came in, or 0.
 */
export async function dropSteered(storage: InboxStorage, ids: string[], covers: string[], messages: Record<string, string> = {}): Promise<number> {
  let newest = 0;
  for (const [key, item] of await storage.list<GroupPending>({ prefix: "gpending:" })) {
    if (!ids.includes(item.message.eventId) && (item.ev === undefined || !ids.includes(item.ev))) continue;
    if (item.ev !== undefined && !covers.includes(item.ev)) covers.push(item.ev);
    if (item.ev !== undefined && typeof item.message.messageId === "string" && item.message.messageId !== "") messages[item.ev] = item.message.messageId;
    newest = Math.max(newest, item.at ?? 0);
    await storage.delete(key);
  }
  return newest;
}

/** The events the gateway has not taken yet, for it to add to the chat's day from the ledger (`packages/tex/gateway/agent/warmCopy.js` `mergeEvents`). */
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
