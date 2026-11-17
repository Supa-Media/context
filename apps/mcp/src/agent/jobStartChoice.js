/**
 * Whether a background job Tex asks for starts now: the Job start node over the turn's config (`graph/nodes/jobStart.js`,
 * `packages/shared/src/jobStart.cjs`), logged to the chat's ledger like every node (and a Lab test chat's card, `env`).
 * While the config has no such node (it is on the shelf), the same rule decides on today's limits, so nothing changes
 * until a Lab draft wires it. A node that fails falls back to the rule on its config's limits, never to a refusal.
 */
import { configStartLimits, decideStart } from "../../../../packages/shared/src/jobStart.cjs";
import { gatewayGraph } from "./graph/gatewayGraph.js";
import { TEX_CONFIG } from "./texConfig.js";

/** `(facts) => Promise<choice>` for `backgroundSession`'s `chooseStart`. */
export function jobStartChooser({ env = null, config = TEX_CONFIG, writer = null, turn = null } = {}) {
  if (!config.nodes.some((node) => node.id === "jobStart" && node.on !== false)) return async (facts) => decideStart(facts, null);
  const graph = gatewayGraph({ env, writer, turn, config });
  return async (facts) => {
    try {
      const { output } = await graph.runNode("jobStart", facts, {}, "startJob");
      if (output && typeof output.to === "string") return output;
    } catch {
      /* the rule below decides */
    }
    return decideStart(facts, configStartLimits(config));
  };
}
