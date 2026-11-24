/**
 * The group card node: after the Learn step, the person's own Tex keeps their member card, `tex/group-card.md`, in step
 * with About me (`../../groupCard.js`; `docs/decisions/texting-assistant/member-cards.md`). A wire from Learn
 * (`learn -> groupCard`, `uses`) turns it on; Learn calls it when its memory nudge ran, about every ten texts. Only on
 * the person's own texted turn in their personal workspace, with write access, as the memory nudge. One small built-in
 * model call, and only when About me changed since the card was written. Its output is the outcome and counts, never a
 * line's words. It never throws.
 */
import { keepGroupCard } from "../../groupCard.js";
import { ownDispatch } from "../../reflect.js";
import { runTurn } from "../../turn.js";
import { builtinModel } from "../../builtin.js";
import { aiGatewayConfig } from "../../aiGateway.js";
import { ProviderError } from "../../providers.js";
import { builtinMeter } from "../../jobLog.js";
import { TEXTS_CLIENT_ID } from "../../../../../../apps/mcp/src/workspaceStore/personTexting.js";

/** Its one model call: no tools, one round, the answer's text. */
export function cardAsker({ env, controlPlane, session }) {
  return async (question, callTool) => {
    const model = builtinModel(env);
    const meter = builtinMeter(controlPlane, session, model, Date.now());
    try {
      const ran = await runTurn({
        question,
        tools: [],
        callTool,
        env,
        providerOptions: { ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "group_card" } },
        maxRounds: 1,
        roundCap: 1,
      });
      await meter(ran.usage, false, ran.model);
      return ran.answer ?? "";
    } catch (error) {
      await meter(null, true, error instanceof ProviderError ? error.model : model);
      throw error;
    }
  };
}

export async function groupCardNode(input, io) {
  const { env, controlPlane, store, session } = io?.ctx ?? {};
  try {
    const texted = session?.actorClientId === TEXTS_CLIENT_ID;
    const personal = (store?.contexts ?? []).find((entry) => entry.current)?.kind === "personal";
    if (!texted || input?.canWrite !== true || !personal) return { outcome: "skipped" };
    const card = await keepGroupCard({ dispatch: ownDispatch(store, session, env), ask: cardAsker({ env, controlPlane, session }) });
    console.log(JSON.stringify({ event: "group_card", workspace: session.workspaceId, grant: session.grantId, ...card }));
    return card;
  } catch (error) {
    return { outcome: "failed", where: typeof error?.name === "string" ? error.name : "error" };
  }
}
