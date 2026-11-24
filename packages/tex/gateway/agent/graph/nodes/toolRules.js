/**
 * Tool rules node, `toolRules` (config wire `tools -> toolRules`, uses; Dev2, 2026-11-23: the no-shadow steps,
 * `docs/decisions/texting-assistant/no-shadow-steps.md`). Every tool call passes through these rules, which
 * `texEntryPoint/runTheModel.js` wraps around the dispatcher once per turn: Same ask twice (`sameAsk.js`), Where a new
 * note goes (`folderFit.js`) and Links in results (`noteLinks.js`), each a switch of this step (`texNodeSettings.cjs`).
 * The security rules (vault, mail agent, the chat's write lock, their notes kept) are always on and are not here.
 *
 * Its row names the turn's calls and which switchable rules they passed, never a call's arguments or result.
 */

/**
 * Whether the config runs this step: a config without it runs it, as before it had a node; one that draws it runs it
 * only when it is on and tools -> toolRules is wired to it (`scripts/tex-wire-check.mjs` OUTSIDE_CALLS).
 */
export const toolRulesOn = (config) => {
  const node = (config?.nodes ?? []).find((n) => n?.id === "toolRules");
  return node === undefined || (node.on !== false && (config?.edges ?? []).some((e) => e.from === "tools" && e.to === "toolRules"));
};

/** Which of the step's switches are on and off, from its settings (`settingsOf(env, "toolRules")`). */
export function toolRulesState(settings = {}) {
  const names = Object.keys(settings);
  return { on: names.filter((rule) => settings[rule] === true), off: names.filter((rule) => settings[rule] !== true) };
}

/**
 * @param {{ steps?: Array<{ tool?: string }>, settings?: object }} input The turn's tool calls and the step's settings.
 * @returns {{ when: string[], calls: number, tools: string[], on: string[], off: string[] }}
 */
export function toolRulesNode({ steps = [], settings = {} } = {}) {
  const tools = [...new Set(steps.map((call) => call?.tool).filter((name) => typeof name === "string"))].slice(0, 20);
  return { when: ["ruled"], calls: steps.length, tools, ...toolRulesState(settings) };
}
