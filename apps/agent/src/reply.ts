/**
 * What the assistant says back to one inbound text: the decision, with every
 * service injected so it can be tested without a network.
 *
 * Four outcomes for any text:
 * - `link ABC123` links this phone to the account that the code was shown to.
 * - `unlink` disconnects this phone from whichever account it answers from.
 * - From a phone nobody linked that the control plane may set up (let in off
 *   the waitlist, or confirmed on an account with no workspace yet), Tex sets
 *   it up by text, handle first (`setup.ts`), and links it.
 * - From any other phone nobody linked, the reply is a sign-in link that shows
 *   the code to text back, and nothing about whether any account exists. The
 *   link goes out as a text of its own, because iMessage draws a link card
 *   only for a message that is nothing but the link.
 * - From a linked phone, the gateway answers with that person's own grant.
 *
 * An SMS (`sms`) is answered too, because a first text to Tex's new number
 * often goes out green, and silence then reads as broken. But anyone can send
 * an SMS that shows somebody else's number, so its words decide nothing: no
 * LINK or UNLINK, no handle, no model. An unlinked phone gets setup's first
 * step or the sign-in link, a linked one is asked to send it again. Either
 * answer goes to the number itself, never to whoever faked it, and goes as
 * iMessage, so that person's next text is one Tex reads.
 *
 * The assistant introduces itself as Tex (the owner, 2026-10-10): Context is
 * the product and the notes, Tex the assistant people text.
 */

import { isControlWord } from "./controlWords";
import {
  askAgent,
  askLine,
  linkPhone,
  openSession,
  requestLinkInvite,
  ServiceError,
  unlinkPhone,
  type Fetch,
} from "./clients";
import { prepareAttachments, type ImagesLike } from "./attachments";
import { handleCandidate, setupReply, textSetup } from "./setup";
import type { Told } from "./told";
import type { Steer } from "./steer";
import { textsFromAnswer, textsWithExact } from "./format";
import { saveTextsStyle, textSettings, type MenuState, type SettingStep, type TexStyle } from "./texStyle";
import { saveReviewSharing, sharingReply, sharingWords } from "./reviewSharing";
import type { OutgoingPicture } from "./outgoing";
import type { Choice } from "./pickCard";
import type { Offer } from "./dataCards";
import type { JobSteerAsk, RunningJob, StartedJob } from "./jobs";
import type { Inbound } from "./inbound";
import type { WarmDeps } from "./warm";

/**
 * One text to answer. `channel` is set only by the staging simulator, whose
 * replies are written to its log instead of sent (simulator.ts); a Linq
 * delivery never carries it.
 */
/** `setting`: a "Tex, settings" text or a reply to its menu, answered by code and never put to decide (`texStyle.ts`). */
/** `askYes`: a like, love or dislike held as the answer to an ask (`thumbs.ts`), set only by `react`; answered by code, never put to decide. */
export type Message = Extract<Inbound, { kind: "message" }> & { channel?: "simulator"; setting?: true; askYes?: true };

export type ReplyDeps = {
  fetch: Fetch;
  /** The gateway's sealed warm copy, kept in this sender's object (`warm.ts`). */
  warm?: WarmDeps;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
  /**
   * Texts the person a progress line while a long task runs (`inbox.ts`).
   * Absent, the turn is asked for whole, as before.
   */
  onProgress?: (text: string) => Promise<void>;
  /** Converts a photo the model cannot read (`attachments.ts`); absent, it is described instead. */
  images?: ImagesLike;
  /** Told when setup started a bucket, so the ready text is owed (`ready.ts`); absent, none is. */
  onSetUp?: () => Promise<void>;
  /**
   * The fixed texts sent outside a turn that the next turn's history is owed
   * (`told.ts`): named to the gateway with the next text, beside the events
   * that carry them, and `onToldDelivered` once a turn answered with them.
   * `onTold` notes a fixed text that went (a setup that finished).
   */
  told?: Told[];
  onToldDelivered?: () => Promise<void>;
  onTold?: (told: Told) => Promise<void>;
  /** Told when the reply is the model's answer, not one of the Worker's own fixed texts. */
  onAnswered?: () => void;
  /** Told when the turn texted a link to save a login (`vaultWatch.ts`); absent, nothing watches for the save. */
  onVaultLink?: () => Promise<void>;
  /** Handed the pictures an answer texts back (`outgoing.ts`); absent, they are not sent. */
  onPictures?: (pictures: OutgoingPicture[], choices: Choice[]) => void;
  /** Handed the data cards an answer offers (`dataCards.ts`); absent, none go. */
  onOffers?: (offers: Offer[]) => void;
  /**
   * Not the last try (`inbox.ts`): a text that could not be started (the
   * control plane unreachable, or the gateway answering 503 before the turn
   * ran, as during a deploy) throws `TryLater` instead of saying something
   * went wrong. Never for a turn that started: its tools may have run.
   */
  retry?: boolean;
  /**
   * Names the turn, so a text sent while it runs can join it (`inbox.ts`):
   * `onSession` is handed the session the turn runs as, and `onSteered` the
   * texts it took in, once it answered. Absent, a text waits its turn.
   */
  steer?: Steer;
  /** The chat's event ids this turn answers (`events.ts`), sent to `/agent` as `covers` with the chat's key. */
  covers?: string[];
  /** When the first text this turn answers came in, sent to `/agent` so the turn log shows how long it waited. */
  arrivedAt?: number;
  /** Handed the approval records the turn armed and the ask line shown for them, so each is logged as an ask (`events.ts`). */
  onAsks?: (askIds: string[], askText: string) => void;
  /**
   * The chat's background jobs, shown to the turn, and handed the ones it
   * started (`jobs.ts`). Absent, the turn is offered none.
   */
  running?: RunningJob[];
  /** Resolves to a line for the answer when a job Tex said it started never did (`notStartedText`). */
  onJobs?: (jobs: StartedJob[]) => Promise<string | undefined | void>;
  /** Handed the running jobs this text was passed to (`jobs.ts`). */
  onSteers?: (asks: JobSteerAsk[]) => Promise<string | undefined | void>;
  /**
   * "Tex, settings" (`texStyle.ts`): where the open menu is kept, and handed
   * the person's style each session so the quick tapback can follow it.
   * Absent, settings texts go to the model like any other.
   */
  settings?: { state: () => Promise<MenuState | undefined>; open: (step?: SettingStep) => Promise<void>; close: () => Promise<void> };
  onTexStyle?: (style: TexStyle | undefined) => Promise<void>;
  /** A texted yes to sharing with the devs: file what this chat keeps, once (`reviewWatch.ts` `watchShared`). */
  onShared?: () => Promise<void>;
};

/** Thrown, with `retry`, when nothing ran and the text can be answered again later. */
export class TryLater extends Error {
  constructor() {
    super("try this text again later");
    this.name = "TryLater";
  }
}

/**
 * The code the app shows is 8 characters from an unambiguous alphabet, but the
 * pattern accepts 6 to 10 letters and digits so a later change of length is a
 * control-plane change only. Brute force is the control plane's to refuse.
 */
const LINK_COMMAND = /^\s*link\s+([a-z0-9]{6,10})\s*[.!]?\s*$/i;
const UNLINK_COMMAND = /^\s*unlink\s*[.!]?\s*$/i;

export const COPY = {
  linked: (handle: string) =>
    `I'm Tex, and you're connected to @${handle}'s Context. Text me anything: questions about your notes, or things to do. If that isn't your account, text UNLINK.`,
  linkRefused:
    "That code didn't work. Codes expire after 10 minutes, so open the link again for a fresh one, or text me anything for a new link.",
  unlinked: (url: string) => [
    "Hi, I'm Tex, your Context assistant. Tap the link below to connect your account, then text me the code it shows you.",
    url,
  ],
  unlinkedNoLink:
    "Hi, I'm Tex, your Context assistant. Text me again in a little while and I'll send you a link to connect your account.",
  unlinkDone: "Done. This phone is no longer connected to your Context. Text me anytime to connect again.",
  unlinkNothing: "This phone isn't connected to any account.",
  noModel:
    "I can't answer right now. Please text me again in a little while.",
  dailyLimit:
    "That's all the questions I can answer for you today. Text me again tomorrow.",
  unavailable: "Something went wrong on my side. Please try again in a minute.",
  /** A linked phone's SMS: never answered from the notes, since its sender can be faked. */
  sms: "Hi, it's Tex. That text came through as SMS, and I only open your notes over iMessage, since anyone can send an SMS that looks like it's from your number. Send it again here and I'll answer.",
  /**
   * No bucket yet: right after setup by text, a new one takes a minute or two
   * to answer (`setup.ts` says so), and a text in that window used to get
   * `unavailable`, which reads as broken on the first try.
   */
  noStorage:
    "Your notes aren't ready for me yet. If you just signed up, they're still being set up, and I'll text you as soon as they're ready. Otherwise, reconnect your storage in Context.",
};

export function linkCode(text: string): string | null {
  const match = LINK_COMMAND.exec(text);
  return match ? match[1].toUpperCase() : null;
}

/**
 * The texts to send back, in order: one for a short answer, a few when it has
 * paragraphs, and a link always on its own.
 */
export async function replyTo(message: Message, deps: ReplyDeps): Promise<string[]> {
  const reply = await answer(message, deps);
  return typeof reply === "string" ? [reply] : reply;
}

async function answer(message: Message, deps: ReplyDeps): Promise<string | string[]> {
  try {
    const code = message.sms ? null : linkCode(message.text);
    if (code) {
      const linked = await linkPhone(
        deps.fetch,
        deps.controlPlaneOrigin,
        deps.workerSecret,
        message.from,
        code,
      );
      return linked.status === "linked" ? COPY.linked(linked.handle) : COPY.linkRefused;
    }

    if (!message.sms && UNLINK_COMMAND.test(message.text)) {
      const result = await unlinkPhone(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.from);
      return result === "unlinked" ? COPY.unlinkDone : COPY.unlinkNothing;
    }

    const session = await openSession(
      deps.fetch,
      deps.controlPlaneOrigin,
      deps.workerSecret,
      message.from,
    ).catch((error) => {
      throw deps.retry && error instanceof ServiceError ? new TryLater() : error;
    });
    // Nobody texted a save's turn (`vaultWatch.ts`): a phone unlinked since is told nothing.
    if (message.event !== undefined && session.status === "unlinked") return [];
    if (session.status === "unlinked") {
      // Nothing but one word of the text goes, and no model runs before a link.
      const setup = await textSetup(
        deps.fetch,
        deps.controlPlaneOrigin,
        deps.workerSecret,
        message.from,
        message.sms ? undefined : handleCandidate(message.text),
      );
      if (setup.status === "set_up" && setup.storage === "on_the_way") await deps.onSetUp?.();
      if (setup.status === "set_up") await deps.onTold?.("setup");
      if (setup.status !== "not_eligible") return setupReply(setup);
      const invite = await requestLinkInvite(
        deps.fetch,
        deps.controlPlaneOrigin,
        deps.workerSecret,
        message.from,
      );
      return invite.status === "issued" ? COPY.unlinked(invite.url) : COPY.unlinkedNoLink;
    }

    if (message.sms) return COPY.sms;
    await deps.onTexStyle?.(session.texStyle);
    // "Tex, settings", a reply to its menu, or "less emoji": set by the person, never the model (`texStyle.ts`).
    const settings = deps.settings && !message.event
      ? await textSettings(message.text, session.texStyle ?? {}, deps.settings, (patch) => saveTextsStyle(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.from, patch))
      : null;
    if (settings !== null) return settings;
    // "Tex, share my chats with the devs", or stop: the person's own words, never the model's (`reviewSharing.ts`).
    const sharing = message.event ? null : sharingWords(message.text);
    if (sharing !== null) {
      const answer = await saveReviewSharing(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.from, sharing);
      const backfill = sharing === "on" && answer?.status === "ok" && answer.changed && deps.onShared !== undefined;
      if (backfill) await deps.onShared?.();
      return sharingReply(sharing, answer, { backfill });
    }

    // Files are fetched only for a linked phone, and only now: an unlinked
    // stranger's photo is never downloaded.
    const attachments = message.attachments?.length
      ? await prepareAttachments(message.attachments, { fetch: deps.fetch, images: deps.images })
      : [];
    // The session is the chat's: its buffered events are written before the turn reads the log (`events.ts`).
    await deps.steer?.onSession(session.accessToken);
    const answer = await askAgent(
      deps.fetch,
      deps.gatewayOrigin,
      session.accessToken,
      message.text,
      deps.onProgress,
      session.timeZone,
      attachments,
      // Somebody else's words, kept apart from the person's (`apps/mcp/src/agent/quoted.js`).
      message.quoted ?? (message.threaded ? "" : undefined),
      message.threadStart,
      { tapback: message.tapback, reacted: message.reacted, turn: deps.steer?.turn, running: deps.running, event: message.event, jobReport: message.jobReport, covers: deps.covers, chat: message.chatId, told: deps.told, texStyle: session.texStyle, arrivedAt: deps.arrivedAt, warm: await deps.warm?.get(), recent: await deps.warm?.recent(message.chatId), holdsLog: message.chatId ? await deps.warm?.holds(message.chatId) : undefined },
    );
    if (answer.kind !== "answer") await deps.warm?.keep(undefined); // a turn that didn't answer may have written: the next one reads whole (`warm.ts`)
    // Cancelled for a restart (`steer.ts`): the turn that replaces it answers.
    if (answer.kind === "cancelled") return [];
    if (answer.kind === "answer") {
      deps.onAnswered?.();
      // Kept when it started a job too: a job reports through the chat's own turn (never writes the chat itself), and the gateway reads notes and skills fresh while one runs (`warmCopy.js` `jobBusy`).
      await deps.warm?.keep(answer.warm);
      if (answer.log && message.chatId) await deps.warm?.keepLog(message.chatId, answer.log); // the chat's log, held here from now on (`events.ts` `keepLog`)
      await deps.onToldDelivered?.();
      if (answer.askIds) deps.onAsks?.(answer.askIds, askLine(answer));
      if (answer.vaultWatch) await deps.onVaultLink?.();
      const notStarted = answer.jobs ? await deps.onJobs?.(answer.jobs) : undefined;
      const notResumed = answer.steers ? await deps.onSteers?.(answer.steers) : undefined;
      if (answer.steered) await deps.steer?.onSteered(answer.steered);
      if (answer.pictures.length > 0) deps.onPictures?.(answer.pictures, answer.choices ?? []);
      if (answer.offers) deps.onOffers?.(answer.offers);
      const after = [notStarted, notResumed].filter((line): line is string => typeof line === "string" && line !== "");
      // A job's report the coordinator found nothing new in is said to nobody (`jobTexts.ts`): the gateway's flag, never a word; a bare control word is never a text either.
      if (!answer.text || answer.quiet || isControlWord(answer.text)) return after;
      // What the person is asked to approve goes out exactly as the gateway
      // wrote it: formatting drops links and lines, and they may allow only
      // what they read (`apps/mcp/src/tools/emailGate.js`).
      return [...textsWithExact(answer.text, answer.verbatim, session.texStyle?.bubbles === "one"), ...after];
    }
    if (answer.kind === "not_started" && deps.retry) throw new TryLater();
    // A save's turn that could not run says nothing: they asked nothing, and their next text carries the task on.
    if (message.event !== undefined) return [];
    if (answer.kind === "no_model") return COPY.noModel;
    if (answer.kind === "daily_limit") return COPY.dailyLimit;
    if (answer.kind === "no_storage") return COPY.noStorage;
    return COPY.unavailable;
  } catch (error) {
    if (error instanceof ServiceError) return message.event !== undefined ? [] : COPY.unavailable;
    throw error;
  }
}
