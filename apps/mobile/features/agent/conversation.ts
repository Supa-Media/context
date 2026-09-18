/**
 * What has been said, and what may be said next.
 *
 * Pure, for the reason `dictation.ts` is pure: the rules about what is allowed
 * to happen next are the part worth testing, and a renderer is not needed to
 * check them. `AgentPanel` draws whatever this says and decides nothing.
 *
 * ## One turn in flight, always
 *
 * The transcript is the conversation's only record of order, and two requests
 * in flight land in whichever order the network settles them. A transcript
 * that interleaves two questions and two answers wrongly is worse than a
 * disabled send button, so `canAsk` is false while one is out — and `ask`
 * enforces it rather than trusting every caller to have checked.
 *
 * ## A failure is not a reset
 *
 * `VoiceButton` already holds this judgement for the microphone: when a meeting
 * takes the mic mid-dictation, the pending phrase is dropped but "the sentences
 * already in the note were said on purpose". The same applies here. A model
 * that could not be reached is a reason to say so, not a reason to throw away
 * what somebody typed.
 */

export interface Turn {
  who: "person" | "agent";
  text: string;
}

export type Conversation =
  /** Nothing is out. A question may be asked. */
  | { name: "idle"; turns: Turn[] }
  /** A question is out. The last turn is the person's. */
  | { name: "thinking"; turns: Turn[] }
  /** The last question did not come back. The turns are kept. */
  | { name: "failed"; turns: Turn[]; reason: string };

export const EMPTY_CONVERSATION: Conversation = { name: "idle", turns: [] };

/** Whether the send control is live. Read by the button and the send key alike. */
export function canAsk(conversation: Conversation): boolean {
  return conversation.name !== "thinking";
}

/**
 * Record a question and wait for it.
 *
 * Returns the conversation unchanged — by identity, so a `useState` setter
 * re-renders nothing — when the question is blank or one is already out.
 */
export function ask(conversation: Conversation, text: string): Conversation {
  if (!canAsk(conversation)) return conversation;

  /*
    Trimmed at the edges only. A trailing newline is what a send key leaves
    behind and would make two identical questions look different in the
    transcript; the line breaks in the middle are somebody's pasted list.
  */
  const asked = text.trim();
  if (asked.length === 0) return conversation;

  return {
    name: "thinking",
    turns: [...conversation.turns, { who: "person", text: asked }],
  };
}

/**
 * Record what came back.
 *
 * Ignored unless something is actually in flight: a late answer whose
 * conversation was cleared underneath it would otherwise put an agent turn at
 * the top of an empty transcript, replying to a question nobody can see.
 */
export function answered(conversation: Conversation, text: string): Conversation {
  if (conversation.name !== "thinking") return conversation;

  return {
    name: "idle",
    turns: [...conversation.turns, { who: "agent", text }],
  };
}

/** Record that the question did not come back, keeping what was already said. */
export function failed(conversation: Conversation, reason: string): Conversation {
  if (conversation.name !== "thinking") return conversation;

  return { name: "failed", turns: conversation.turns, reason };
}

/** Start again. What closing the panel and pressing Clear both do. */
export function clear(_conversation: Conversation): Conversation {
  return EMPTY_CONVERSATION;
}
