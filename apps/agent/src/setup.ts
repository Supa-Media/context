/**
 * Setting somebody up by text: the Worker's half (Dev2, 2026-10-17,
 * onboarding happens by text, handle first).
 *
 * A phone let in off the waitlist is told to text Tex, and has no account
 * yet. The control plane decides everything (`apps/convex/functions/
 * textSetup.ts`): whether this phone may be set up, what step it is on, and
 * whether the handle is free. This file only cuts the one-word handle out of
 * the text, so the message itself never leaves the Worker, and words the
 * answers. No model runs until the phone is linked: the exchange is fixed,
 * and nothing the person texts can talk it into anything.
 */

import { post, record, ServiceError, type Fetch } from "./clients";

export type SetupAnswer =
  | { status: "not_eligible" }
  | { status: "ask" }
  | { status: "too_many" }
  | { status: "rejected"; reason: string; handle?: string }
  | { status: "set_up"; handle: string; storage: "on_the_way" | "none"; url?: string };

const HANDLE_SHAPE = /^[a-z0-9-]{1,64}$/;
/** Only an https link to the app's console for that handle is ever texted. */
const CONSOLE_LINK = /^https:\/\/[^\s/]+\/console\/[a-z0-9-]{1,64}$/;

/**
 * The handle a text offers: one word, an `@` and a full stop allowed, else
 * nothing. A sentence is never sent, so the control plane sees one word at most.
 */
export function handleCandidate(text: string): string | undefined {
  const word = text.trim().replace(/^@/, "").replace(/[.!]$/, "");
  if (word.length === 0 || word.length > 64 || /\s/.test(word)) return undefined;
  return word;
}

/**
 * One step of setup for `phone`. A control plane that does not know the route
 * yet (404, mid-deploy) is `not_eligible`, so the old sign-in link goes out.
 */
export async function textSetup(
  fetcher: Fetch,
  origin: string,
  secret: string,
  phone: string,
  candidate: string | undefined,
): Promise<SetupAnswer> {
  const { status, json } = await post(fetcher, "control_plane", `${origin}/agent-texts/setup`, secret, {
    phone,
    ...(candidate === undefined ? {} : { candidate }),
  });
  if (status === 404) return { status: "not_eligible" };
  if (status !== 200) throw new ServiceError("control_plane", status);
  const body = record(json);
  switch (body.status) {
    case "ask":
    case "too_many":
    case "not_eligible":
      return { status: body.status };
    case "rejected": {
      const reason = typeof body.reason === "string" ? body.reason : "invalid";
      const handle = typeof body.handle === "string" && HANDLE_SHAPE.test(body.handle) ? body.handle : undefined;
      return handle === undefined ? { status: "rejected", reason } : { status: "rejected", reason, handle };
    }
    case "set_up": {
      if (typeof body.handle !== "string" || !HANDLE_SHAPE.test(body.handle)) break;
      const storage = body.storage === "on_the_way" ? "on_the_way" : "none";
      const url =
        typeof body.url === "string" && CONSOLE_LINK.test(body.url) && body.url.endsWith(`/console/${body.handle}`)
          ? body.url
          : undefined;
      return { status: "set_up", handle: body.handle, storage, ...(url === undefined ? {} : { url }) };
    }
  }
  throw new ServiceError("control_plane", status);
}

const FORMAT =
  "A handle is 2 to 32 lowercase letters, numbers or hyphens, like @ada or @ada-lovelace. Text me just the one you want.";

/** `ask` is also Tex's first text to a person let in (`TEX_GREETING`, apps/convex/functions/texGreeting.ts): keep the two the same. */
export const SETUP_COPY = {
  ask: "Hi, I'm Tex, your Context assistant. You're in, so let's set you up. First, your handle: it's your name on Context, like @ada. Text me the one you want.",
  taken: (handle?: string) =>
    `${handle === undefined ? "That handle" : `@${handle}`} is taken. Try another one?`,
  reserved: (handle?: string) =>
    `${handle === undefined ? "That handle" : `@${handle}`} is reserved. Try another one?`,
  format: FORMAT,
  tooMany: "That's a lot of tries for one hour. Text me again in a little while and we'll pick up where we left off.",
  setUp: (handle: string, storage: "on_the_way" | "none", linked = true) => {
    const where = linked ? "at the link below" : "in the Context app";
    return storage === "on_the_way"
      ? `You're all set, @${handle}. I'm getting your notes ready now, so give me a minute, then text me anything: a question, a reminder, something to remember. Your workspace is ${where}. If this isn't you, text UNLINK.`
      : `You're all set, @${handle}. One more step before I can keep notes for you: open your workspace ${where} and connect storage. If this isn't you, text UNLINK.`;
  },
};

/** The texts for a setup step, the workspace link on its own so iMessage draws a card. */
export function setupReply(answer: Exclude<SetupAnswer, { status: "not_eligible" }>): string[] {
  switch (answer.status) {
    case "ask":
      return [SETUP_COPY.ask];
    case "too_many":
      return [SETUP_COPY.tooMany];
    case "rejected":
      if (answer.reason === "taken") return [SETUP_COPY.taken(answer.handle)];
      if (answer.reason === "reserved") return [SETUP_COPY.reserved(answer.handle)];
      return [SETUP_COPY.format];
    case "set_up":
      return answer.url === undefined
        ? [SETUP_COPY.setUp(answer.handle, answer.storage, false)]
        : [SETUP_COPY.setUp(answer.handle, answer.storage), answer.url];
  }
}
