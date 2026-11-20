import { TEX_CONFIG, texToolList } from "../../../packages/tex/gateway/agent/texConfig.js";
import { sixToolsOver } from "../../../packages/tex/gateway/agent/sixTools.js";
import { fixedCarriers } from "../../../packages/tex/gateway/agent/sixToolsFixed.js";

/**
 * What a model was shown, read off the six tools the texting assistant holds
 * (`src/agent/sixTools.js`): each tool's name, and each action its
 * description lists, as `tool.action` (`write.propose`, `send.browse`).
 */
export function shown(tools) {
  const names = new Set();
  for (const tool of tools ?? []) {
    names.add(tool.name);
    const listed = String(tool.description ?? "").split("Your actions:\n")[1];
    if (!listed) continue;
    for (const line of listed.split("\n")) {
      const action = /^- ([a-z_]+):/.exec(line);
      if (action) names.add(`${tool.name}.${action[1]}`);
    }
  }
  return names;
}

/**
 * Whether a texted turn runs on the fixed list (`sixToolsFixed.js`): every texted turn of a kind is then shown the same
 * actions and refused the ones it does not hold, so a check that a turn is *not shown* an action holds only per turn.
 * `sixToolsFixed.test.mjs` proves the refusal.
 */
export const onFixedList = (step = "fd") => texToolList(step, TEX_CONFIG) === "fixed";

/** An action's whole guide on the fixed list, as `fetch manual:<action>` gives it (one: a 1:1's; group: a group's). */
export function manualOf(action, kind = "one") {
  const carriers = fixedCarriers(kind);
  return sixToolsOver([...carriers.values()], null, { shown: carriers }).resolve("fetch", { id: `manual:${action}` }).text ?? "";
}
