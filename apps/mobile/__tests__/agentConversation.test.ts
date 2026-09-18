import { describe, expect, test } from "@jest/globals";
import {
  EMPTY_CONVERSATION,
  answered,
  ask,
  canAsk,
  clear,
  failed,
  type Conversation,
} from "../features/agent/conversation";

/**
 * THE CONVERSATION, AS A STATE MACHINE RATHER THAN A COMPONENT.
 *
 * `useDictation` makes the same split for the microphone and it is the reason
 * `dictation.ts` can be tested without a renderer: the part that decides what
 * is allowed to happen next is pure, and the part that draws it is not.
 *
 * ## The two rules that are not obvious
 *
 * **A turn cannot be sent while one is in flight.** Not because a second
 * request would be expensive — on a stub it costs nothing — but because the
 * transcript is the conversation's only record of order. Two asks in flight
 * land in whichever order the network settles them, and a transcript that
 * interleaves two questions and two answers wrongly is worse than a disabled
 * button. `canAsk` is the one place that says so, and both the panel's send
 * key and its button read it.
 *
 * **A failure keeps the turns.** The same judgement `VoiceButton` makes when a
 * meeting starts mid-dictation: "the sentences already in the note were said on
 * purpose and starting a meeting is not a request to delete them". A model that
 * could not be reached is not a reason to throw away what somebody typed —
 * they may want to copy it, retry it, or read what the agent already said.
 *
 * ## Sabotage record
 *
 * Applied to `features/agent/conversation.ts`, suite run, named test observed
 * failing, reverted.
 *
 *  1. `canAsk` returning `true` while thinking.
 *     → **1 fails**: `a second question cannot be sent while the first is in
 *     flight`. This is the transcript-ordering bug, and it is invisible on a
 *     stub that answers synchronously — which is exactly why it is asserted on
 *     the state rather than observed through the panel.
 *  2. `ask` accepting a blank prompt.
 *     → **2 fail**: `a blank question is not a question` and `whitespace is
 *     blank`. An empty turn in the transcript reads as the person having said
 *     nothing, and spends a request to prove it.
 *  3. `failed` dropping the turns (`turns: []`).
 *     → **2 fail**: `a failure keeps everything that was already said` and
 *     `asking again clears the failure without clearing the transcript` — a
 *     retry after a failure would come back with the retry alone in it.
 *  4. `answered` appending without clearing `thinking`.
 *     → **2 fail**: `an answer returns the conversation to idle` and `a
 *     question can be asked once the answer has arrived` — the panel would
 *     never re-enable its send button.
 */

const PROMPT = "What did we decide about pricing?";
const REPLY = "You moved to $5 on 2026-09-12, holding it for early testers.";

/** The state after one question has been asked and nothing has come back. */
function inFlight(): Conversation {
  return ask(EMPTY_CONVERSATION, PROMPT);
}

describe("asking", () => {
  test("an empty conversation has nothing in it and is ready", () => {
    expect(EMPTY_CONVERSATION.turns).toEqual([]);
    expect(EMPTY_CONVERSATION.name).toBe("idle");
    expect(canAsk(EMPTY_CONVERSATION)).toBe(true);
  });

  test("asking records what the person said and waits", () => {
    const next = inFlight();

    expect(next.name).toBe("thinking");
    expect(next.turns).toEqual([{ who: "person", text: PROMPT }]);
  });

  test("a second question cannot be sent while the first is in flight", () => {
    const next = inFlight();

    expect(canAsk(next)).toBe(false);
    // And the guard holds even if a caller ignores `canAsk`.
    expect(ask(next, "and what about storage?")).toBe(next);
  });

  test("a blank question is not a question", () => {
    expect(ask(EMPTY_CONVERSATION, "")).toBe(EMPTY_CONVERSATION);
  });

  test("whitespace is blank", () => {
    expect(ask(EMPTY_CONVERSATION, "   \n\t ")).toBe(EMPTY_CONVERSATION);
  });

  test("a question keeps its own spacing but not its edges", () => {
    /*
      Trimmed because a trailing newline is what a send key leaves behind, and
      an untrimmed prompt makes two identical questions look different in the
      transcript. The middle is left alone: somebody pasting a list into the
      box meant the line breaks.
    */
    const next = ask(EMPTY_CONVERSATION, "  first line\nsecond line  ");

    expect(next.turns[0]?.text).toBe("first line\nsecond line");
  });
});

describe("answering", () => {
  test("an answer returns the conversation to idle", () => {
    const next = answered(inFlight(), REPLY);

    expect(next.name).toBe("idle");
    expect(next.turns).toEqual([
      { who: "person", text: PROMPT },
      { who: "agent", text: REPLY },
    ]);
  });

  test("a question can be asked once the answer has arrived", () => {
    expect(canAsk(answered(inFlight(), REPLY))).toBe(true);
  });

  test("an answer to nothing is ignored", () => {
    /*
      A late answer from a request whose conversation was cleared underneath it.
      Appending it would put an agent turn at the top of an empty transcript,
      answering a question that is no longer on screen.
    */
    expect(answered(EMPTY_CONVERSATION, REPLY)).toBe(EMPTY_CONVERSATION);
  });
});

describe("failing", () => {
  test("a failure keeps everything that was already said", () => {
    const next = failed(inFlight(), "The model could not be reached.");

    expect(next.turns).toEqual([{ who: "person", text: PROMPT }]);
  });

  test("a failure says why, and lets another question be asked", () => {
    const next = failed(inFlight(), "The model could not be reached.");

    expect(next.name).toBe("failed");
    expect(next.name === "failed" ? next.reason : null).toBe("The model could not be reached.");
    expect(canAsk(next)).toBe(true);
  });

  test("asking again clears the failure without clearing the transcript", () => {
    const next = ask(failed(inFlight(), "The model could not be reached."), "try again");

    expect(next.name).toBe("thinking");
    expect(next.turns.map((turn) => turn.text)).toEqual([PROMPT, "try again"]);
  });
});

describe("clearing", () => {
  test("clearing empties the transcript", () => {
    expect(clear(answered(inFlight(), REPLY))).toEqual(EMPTY_CONVERSATION);
  });

  test("clearing mid-flight is allowed and lands idle", () => {
    /*
      Somebody who closes the panel while a turn is in flight has left. The
      answer that eventually arrives is dropped by `answered` above, rather
      than reopening anything.
    */
    expect(clear(inFlight())).toEqual(EMPTY_CONVERSATION);
  });
});
