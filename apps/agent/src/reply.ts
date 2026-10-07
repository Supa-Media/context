/**
 * What the assistant says back to one inbound text: the decision, with every
 * service injected so it can be tested without a network.
 *
 * Four outcomes for any text:
 * - `link ABC123` links this phone to the account that the code was shown to.
 * - `unlink` disconnects this phone from whichever account it answers from.
 * - From a phone nobody linked, the reply is a sign-in link that shows the
 *   code to text back, and nothing about whether any account exists. The link
 *   goes out as a text of its own, because iMessage draws a link card only for
 *   a message that is nothing but the link.
 * - From a linked phone, the gateway answers with that person's own grant.
 */

import {
  askAgent,
  linkPhone,
  openSession,
  requestLinkInvite,
  ServiceError,
  unlinkPhone,
  type Fetch,
} from "./clients";
import { textsFromAnswer } from "./format";
import type { Inbound } from "./inbound";

/**
 * One text to answer. `channel` is set only by the staging simulator, whose
 * replies are written to its log instead of sent (simulator.ts); a Linq
 * delivery never carries it.
 */
export type Message = Extract<Inbound, { kind: "message" }> & { channel?: "simulator" };

export type ReplyDeps = {
  fetch: Fetch;
  controlPlaneOrigin: string;
  workerSecret: string;
  gatewayOrigin: string;
};

/**
 * The code the app shows is 8 characters from an unambiguous alphabet, but the
 * pattern accepts 6 to 10 letters and digits so a later change of length is a
 * control-plane change only. Brute force is the control plane's to refuse.
 */
const LINK_COMMAND = /^\s*link\s+([a-z0-9]{6,10})\s*[.!]?\s*$/i;
const UNLINK_COMMAND = /^\s*unlink\s*[.!]?\s*$/i;

export const COPY = {
  linked: (handle: string) =>
    `You're connected to @${handle}'s Context. Text me anything and I'll answer from your notes. If that isn't your account, text UNLINK.`,
  linkRefused:
    "That code didn't work. Codes expire after 10 minutes, so open the link again for a fresh one, or text me anything for a new link.",
  unlinked: (url: string) => [
    "Hi, I'm your Context. Tap the link below to connect your account, then text me the code it shows you.",
    url,
  ],
  unlinkedNoLink:
    "Hi, I'm your Context. Text me again in a little while and I'll send you a link to connect your account.",
  unlinkDone: "Done. This phone is no longer connected to your Context. Text me anytime to connect again.",
  unlinkNothing: "This phone isn't connected to any account.",
  noModel:
    "I can't answer yet because no AI model is connected to your Context. Connect one in Settings, then text me again.",
  dailyLimit:
    "That's all the questions I can answer for you today. Text me again tomorrow, or connect your own AI account in Context under Settings for no limit.",
  unavailable: "Something went wrong on my side. Please try again in a minute.",
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
    const code = linkCode(message.text);
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

    if (UNLINK_COMMAND.test(message.text)) {
      const result = await unlinkPhone(deps.fetch, deps.controlPlaneOrigin, deps.workerSecret, message.from);
      return result === "unlinked" ? COPY.unlinkDone : COPY.unlinkNothing;
    }

    const session = await openSession(
      deps.fetch,
      deps.controlPlaneOrigin,
      deps.workerSecret,
      message.from,
    );
    if (session.status === "unlinked") {
      const invite = await requestLinkInvite(
        deps.fetch,
        deps.controlPlaneOrigin,
        deps.workerSecret,
        message.from,
      );
      return invite.status === "issued" ? COPY.unlinked(invite.url) : COPY.unlinkedNoLink;
    }

    const answer = await askAgent(deps.fetch, deps.gatewayOrigin, session.accessToken, message.text);
    if (answer.kind === "answer") return textsFromAnswer(answer.text);
    if (answer.kind === "no_model") return COPY.noModel;
    if (answer.kind === "daily_limit") return COPY.dailyLimit;
    return COPY.unavailable;
  } catch (error) {
    if (error instanceof ServiceError) return COPY.unavailable;
    throw error;
  }
}
