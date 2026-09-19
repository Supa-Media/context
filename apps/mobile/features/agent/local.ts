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
