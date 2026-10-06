/**
 * What the assistant says back to one inbound text: the decision, with every
 * service injected so it can be tested without a network.
 *
 * Three outcomes for any text:
 * - `link ABC123` links this phone to the account that the code was shown to.
 * - From a phone nobody linked, the reply says how to link one, and nothing
 *   about whether any account exists.
 * - From a linked phone, the gateway answers with that person's own grant.
 */

import {
  askAgent,
  linkPhone,
  openSession,
  ServiceError,
  type Fetch,
} from "./clients";
import type { Inbound } from "./inbound";

export type Message = Extract<Inbound, { kind: "message" }>;

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

export const COPY = {
  linked: (handle: string) =>
    `You're connected to @${handle}'s Context. Text me anything and I'll answer from it. If that isn't your account, open Context, go to Settings › Texts, and unlink this phone.`,
  linkRefused:
    "That code didn't work. Codes expire after 10 minutes, so make a new one in Context under Settings › Texts and text it here.",
  unlinked:
    "Hi! I'm the Context assistant. To use me, open Context, go to Settings › Texts, and text me the code it shows you.",
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

export async function replyTo(message: Message, deps: ReplyDeps): Promise<string> {
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

    const session = await openSession(
      deps.fetch,
      deps.controlPlaneOrigin,
      deps.workerSecret,
      message.from,
    );
    if (session.status === "unlinked") return COPY.unlinked;

    const answer = await askAgent(deps.fetch, deps.gatewayOrigin, session.accessToken, message.text);
    if (answer.kind === "answer") return answer.text;
    if (answer.kind === "no_model") return COPY.noModel;
    if (answer.kind === "daily_limit") return COPY.dailyLimit;
    return COPY.unavailable;
  } catch (error) {
    if (error instanceof ServiceError) return COPY.unavailable;
    throw error;
  }
}
