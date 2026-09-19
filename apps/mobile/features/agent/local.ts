import { getDesktopBridge, type DesktopBridge, type LocalAgentReply } from "@context/desktop-bridge";
import { agentRequest } from "./gateway";
import type { AgentPage } from "./page";

/**
 * The second road a question can take: the `claude` on this machine.
 *
 * The gateway road spends an API key the customer pasted into Settings →
 * Model. This one runs the coding CLI they already have, under the login they
 * made themselves, so the answer comes out of the subscription they already
 * pay for and costs them nothing extra.
 *
 * It exists only inside the desktop shell, and that is a property of the thing
 * rather than a limitation of this file: a browser has no `claude` to run and
 * a Worker has neither the binary nor the keychain. `apps/desktop/src/core/agent/localCli.ts`
 * carries the reasoning, including why Anthropic's own rule about third-party
 * logins is satisfied by this and not by the alternatives.
 *
 * ## Asked for the member, never the version
 *
 * `meetingsWriterFor`'s rule, for its reason: `MIN_BRIDGE_VERSION` is still 1,
 * so a shell installed before this shipped is a valid shell that simply has no
 * `agent`. It takes the gateway road, which is a real product rather than a
 * degraded one — the same road every browser takes.
 *
 * And the member is checked rather than the bridge, because a bridge without
 * `agent` and a bridge with one are two different answers here.
 */

/** What the panel needs to know to offer, or not offer, the local road. */
export interface LocalRoute {
  ask(input: { question: string; place: AgentPage }): Promise<LocalAgentReply>;
}

/**
 * The local road, or `null` when this build cannot take it.
 *
 * `null` covers a browser, a phone, a subframe, a shell this bundle does not
 * understand, and a shell older than version 7 — all the same answer, and none
 * of them an error anybody is shown.
 */
export function localRouteFrom(bridge: DesktopBridge | null = getDesktopBridge()): LocalRoute | null {
  const agent = bridge?.agent;
  if (agent === undefined || typeof agent.ask !== "function") return null;
  return {
    /*
      The body is built by `agentRequest`, the same function the gateway road
      uses. That is the whole reason it is shared: the two roads are told about
      the room in one format, decided in one file, with one test planting a
      sentinel in a note body and checking it does not travel. A second shape
      here would be a second place for note text to leak into, reached only on
      machines that happen to have a CLI installed — the worst possible
      distribution for a bug of that kind.
    */
    ask: ({ question, place }) => agent.ask(agentRequest(question, place)),
  };
}

/**
 * Whether the local road should be *preferred* when both are available.
 *
 * Yes, and it is not close: it spends a subscription the person already pays
 * for instead of billing their card per question, and it needs no key pasted
 * anywhere. The gateway road stays as the fallback rather than being removed,
 * because it is the only road in a browser and on a phone.
 *
 * Kept as a named function rather than an `if` at the call site so that the
 * day this becomes a setting, there is one place that decides it.
 */
export function preferLocal(local: LocalRoute | null): boolean {
  return local !== null;
}

/** What the panel calls the local road in its header. */
export const LOCAL_PROVIDER = "claude-code";

/**
 * What one attempt at the local road means for the rest of the ask.
 *
 * `answer` and `stop` both end the turn; `gateway` is the only outcome that
 * goes on to spend the customer's API key.
 */
export type AfterLocal =
  | { road: "answer"; answer: string; provider: string }
  | { road: "stop"; sentence: string }
  | { road: "gateway" };

/**
 * Whether a local attempt ends the turn, and why.
 *
 * **This is a pure function because the rule inside it was a comment.** It
 * lived in `useAgentEngine`'s `ask` as control flow, where nothing could reach
 * it — and `features/console/capabilities.ts`'s rule applies here exactly as it
 * does there: *every guard expressed inside a component in this app was held by
 * nothing*. `docs/decisions/testing.md` puts it shorter: a guard nobody has
 * checked is not a guard.
 *
 * ## A local refusal never falls through
 *
 * `ok: false` is a sentence naming a fix **on this machine** — sign in to the
 * CLI, connect this Mac. Falling through to the gateway after showing somebody
 * that would spend their API key silently, moments after telling them the free
 * road needed a two-second fix. That is the single outcome this road exists to
 * avoid, so a refusal stops the turn.
 *
 * ## A shell that vanished does
 *
 * `null` here means the bridge call *threw* — the shell went away mid-question.
 * Nothing was spent, nothing was said, and the person is owed an answer rather
 * than an explanation of our plumbing. So that one falls through, and it is the
 * only thing that does.
 *
 * The distinction is the whole function: "the CLI said no" and "the CLI was not
 * there" look equally like failure at the call site and mean opposite things.
 */
export function afterLocal(reply: LocalAgentReply | null): AfterLocal {
  if (reply === null) return { road: "gateway" };
  if (reply.ok && reply.answer.trim().length > 0) {
    return { road: "answer", answer: reply.answer, provider: reply.provider };
  }
  if (reply.ok) {
    /*
      `ok: true` with nothing in it. The shell should not send this, and if it
      does, falling through would spend a key on a turn that may well have
      already spent a subscription — so it stops, like every other non-answer.
    */
    return { road: "stop", sentence: EMPTY_LOCAL_ANSWER };
  }
  return { road: "stop", sentence: reply.message };
}

/** Shown when the shell answers `ok` with no answer in it. */
export const EMPTY_LOCAL_ANSWER = "Claude Code finished without an answer. Try asking again.";
