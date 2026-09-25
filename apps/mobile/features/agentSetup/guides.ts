/**
 * The guided agent setup: which steps each agent takes, and the words on them.
 *
 * One action per screen, five screens each (the setup-flow brief, as revised
 * by the owner on 2026-09-25). The Claude app only: no "which Claude" picker
 * and no Claude Code, which keeps its own row under Settings › AI apps. Both
 * agents end on the same two steps — make it stick, then bring over what the
 * agent already knows — because a connection that the agent never consults,
 * or that starts with an empty workspace, is one people give up on.
 *
 * Pure, so the step order and every path it names is a test.
 */

export type SetupAgent = "claude" | "chatgpt";

export type StepKey = "open" | "add" | "devmode" | "create" | "signin" | "stick" | "bring";

export const SETUP_AGENTS: readonly SetupAgent[] = ["claude", "chatgpt"];

export const AGENT_NAMES: Record<SetupAgent, string> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

export const GUIDE_STEPS: Record<SetupAgent, readonly StepKey[]> = {
  claude: ["open", "add", "signin", "stick", "bring"],
  chatgpt: ["devmode", "create", "signin", "stick", "bring"],
};

/**
 * Where each agent's own screens live.
 *
 * Claude's settings link is the one `console/clients/providers.ts` hands
 * out, so the guide and Settings send somebody to the same form. ChatGPT's
 * opens its settings rather than the create form, because developer mode has
 * to be switched on there first and the create form does not exist until it is.
 * `chat` is where "Copy and open" goes: a new chat, for the bring-over prompt.
 */
export const AGENT_LINKS: Record<SetupAgent, { settings: string; label: string; chat: string }> = {
  claude: {
    settings: "https://claude.ai/customize/connectors?modal=add-custom-connector",
    label: "Open Claude settings",
    chat: "https://claude.ai/new",
  },
  chatgpt: {
    settings: "https://chatgpt.com/#settings/Connectors",
    label: "Open ChatGPT settings",
    chat: "https://chatgpt.com/",
  },
};

/** Where the standing instruction goes, in each agent's own words. */
export const STICK_FIELD: Record<SetupAgent, { path: readonly string[]; field: string }> = {
  claude: {
    path: ["Settings", "General"],
    field: "What personal preferences should Claude consider in responses?",
  },
  chatgpt: {
    path: ["Settings", "Personalization", "Custom instructions"],
    field: "Anything else ChatGPT should know about you?",
  },
};

/** `?connect=claude` → `"claude"`; anything we did not write closes the guide. */
export function agentFromQuery(value: string | string[] | undefined): SetupAgent | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "claude" || raw === "chatgpt" ? raw : null;
}

/** The step to show, clamped, so stale saved progress can never point past the end. */
export function clampStep(agent: SetupAgent, step: number): number {
  const last = GUIDE_STEPS[agent].length - 1;
  if (!Number.isFinite(step) || step < 0) return 0;
  return Math.min(Math.floor(step), last);
}
