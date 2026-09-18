import { describePlace, type AgentPage } from "./page";

/**
 * The seam between "somebody asked something" and "here is an answer".
 *
 * Shaped after `voice/engine.ts` deliberately — `available`, a sentence for
 * when it is not, and the verbs — because the two surfaces have the same
 * problem: a capability that exists on some platforms and plans and not
 * others, which has to be described to somebody rather than merely switched
 * off. That file's rule applies here too: `unavailable` is *a sentence, not a
 * code*, and it says what does work rather than only what does not.
 *
 * ## Why the loop is not behind this interface
 *
 * `ask` takes a question and answers with text. It does not take tools, it
 * does not return tool calls, and it does not iterate — because in the shipping
 * design the iteration happens in the gateway, where the provider credential is
 * decrypted, and the app never sees a turn boundary. Whatever ends up on the
 * other side of this seam, the app's half stays this small.
 *
 * The one provider that will not fit that shape is Ollama, whose loop has to
 * run on the device because a Worker cannot reach `localhost`. It still fits
 * *this* interface — it is an `ask` that happens to do more work locally — and
 * that is the point of putting the seam here rather than at the HTTP call.
 *
 * ## What ships today
 *
 * A stub. There is no provider connected in this build: storing a provider
 * credential is the next change, and it belongs in the control plane under the
 * same envelope as a storage binding rather than in this app. Until then the
 * stub answers by describing the room, which is the one thing worth proving
 * end to end before a model is on the other end — that the ambient context
 * reaches the seam intact, and carries no note text with it.
 */

export interface AgentEngine {
  /** What the panel calls the thing it is talking to. Shown in its header. */
  readonly provider: string;
  /** Whether a question can be asked at all. */
  readonly available: boolean;
  /** What to tell somebody when it cannot be — a sentence, not a code. */
  readonly unavailable: string;
  /**
   * Ask, and answer.
   *
   * Takes the place rather than a rendered prompt so that the decision about
   * what the model is told about the room stays in `page.ts`, where the test
   * that it carries no note body can see it.
   */
  ask(input: { question: string; place: AgentPage }): Promise<string>;
}

export const NO_PROVIDER =
  "No model is connected yet. Connect one in Settings — your own Anthropic or OpenAI key, " +
  "or an Ollama running on this machine — and it answers from your notes.";

/**
 * The stub that ships until a provider can be stored.
 *
 * It is `available` on purpose. An unavailable stub would leave the whole
 * surface untestable by hand and unreachable in the visual fixture, and the
 * sentence it answers with makes it impossible to mistake for a model.
 */
export function createStubEngine(): AgentEngine {
  return {
    provider: "No model yet",
    available: true,
    unavailable: NO_PROVIDER,
    ask: ({ place }) =>
      Promise.resolve(
        [
          "No model is connected yet, so there is nothing here to answer with.",
          "",
          "What a model would be told about where you are:",
          describePlace(place),
          "",
          "Note text is not in that — the agent reads notes through its own grant, " +
            "so every read passes the privacy rules and lands in your audit trail.",
        ].join("\n"),
      ),
  };
}
